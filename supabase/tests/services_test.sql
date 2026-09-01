-- Tests for the service registry (migration 0003): per-type health gating and
-- the counts the web UI displays.

\set QUIET on
\pset pager off

\set alice '11111111-1111-1111-1111-111111111111'

truncate jobs cascade;
delete from worker_services;
delete from api_keys;
delete from workers;
delete from auth.users;

insert into auth.users (id) values (:'alice');
insert into workers (id, capabilities, token_hash, last_heartbeat) values
  ('gpu-1', '{}',      extensions.crypt('t1', extensions.gen_salt('bf')), now()),
  ('gpu-2', '{video}', extensions.crypt('t2', extensions.gen_salt('bf')), now());

-- 1. report_services -------------------------------------------------------
do $$
begin
  perform report_services('gpu-1', 't1', jsonb_build_array(
    jsonb_build_object('type','llm','name','vllm','healthy',true,
                       'models',jsonb_build_array('qwen3-8b'),'capacity',8),
    jsonb_build_object('type','image','name','vllm-omni','healthy',true,
                       'capacity',1),
    jsonb_build_object('type','video','name','vllm-omni','healthy',false,
                       'detail','ConnectError','capacity',1)
  ));

  perform assert((select count(*) from worker_services where worker_id='gpu-1') = 3,
                 'report_services records every service');
  perform assert((select healthy from worker_services
                  where worker_id='gpu-1' and type='llm'),
                 'healthy service is recorded as up');
  perform assert(not (select healthy from worker_services
                      where worker_id='gpu-1' and type='video'),
                 'unhealthy service is recorded as down');
  perform assert((select detail from worker_services
                  where worker_id='gpu-1' and type='video') = 'ConnectError',
                 'failure detail is kept for display');
  perform assert((select models from worker_services
                  where worker_id='gpu-1' and type='llm') = '{qwen3-8b}',
                 'model list is recorded');
  perform assert((select capacity from worker_services
                  where worker_id='gpu-1' and type='llm') = 8,
                 'capacity is recorded');

  -- Re-reporting must update in place, not accumulate duplicates.
  perform report_services('gpu-1', 't1', jsonb_build_array(
    jsonb_build_object('type','llm','name','vllm','healthy',false,
                       'detail','restarting','capacity',8)
  ));
  perform assert((select count(*) from worker_services where worker_id='gpu-1') = 1,
                 'services dropped from the report are removed, not left stale');
  perform assert(not (select healthy from worker_services
                      where worker_id='gpu-1' and type='llm'),
                 'a service can flip to unhealthy');

  -- Capacity is clamped, so a bad config cannot request an absurd batch.
  perform report_services('gpu-1', 't1', jsonb_build_array(
    jsonb_build_object('type','llm','healthy',true,'capacity',99999)
  ));
  perform assert((select capacity from worker_services
                  where worker_id='gpu-1' and type='llm') = 256,
                 'capacity is clamped to a sane maximum');

  perform report_services('gpu-1', 't1', jsonb_build_array(
    jsonb_build_object('type','llm','healthy',true,'capacity',0)
  ));
  perform assert((select capacity from worker_services
                  where worker_id='gpu-1' and type='llm') = 1,
                 'capacity is at least 1');

  begin
    perform report_services('gpu-1', 'wrong', '[]'::jsonb);
    raise exception 'FAIL: report_services accepted a bad token';
  exception when sqlstate '28000' then
    raise notice 'ok  report_services requires a valid worker token';
  end;

  begin
    perform report_services('gpu-1', null, '[]'::jsonb);
    raise exception 'FAIL: report_services accepted a null token';
  exception when sqlstate '28000' then
    raise notice 'ok  report_services rejects a null token';
  end;
end $$;

-- 2. Per-type gating: the service report is the source of truth ----------
do $$
declare v_key text; v_n int;
begin
  truncate jobs cascade;
  delete from worker_services;
  delete from api_keys;
  perform set_config('request.jwt.claim.sub',
                     '11111111-1111-1111-1111-111111111111', false);
  v_key := create_api_key('k');

  perform submit_job(v_key, 'llm',   '{"prompt":"a"}'::jsonb);
  perform submit_job(v_key, 'image', '{"prompt":"image"}'::jsonb);
  perform submit_job(v_key, 'video', '{"prompt":"video"}'::jsonb);

  perform report_services('gpu-1', 't1', jsonb_build_array(
    jsonb_build_object('type','llm','healthy',true),
    jsonb_build_object('type','image','healthy',false),
    jsonb_build_object('type','video','healthy',false)
  ));

  -- Only the healthy reported type may be claimed. The legacy capability
  -- column is empty and must not restrict the dynamic report.
  select count(*) into v_n
  from claim_jobs('gpu-1', 't1', '{llm}', 8, 60);
  perform assert(v_n = 1, 'only the live type is claimed');
  perform assert((select type from jobs where status = 'running') = 'llm',
                 'the claimed job is the llm one');
  perform assert((select count(*) from jobs
                  where type in ('image','video') and status = 'queued') = 2,
                 'jobs for down services stay queued');
  perform assert((select max(attempts) from jobs where type = 'video') = 0,
                 'attempts are not burned for a down service');

  -- image comes up: it becomes claimable, video still does not.
  perform report_services('gpu-1', 't1', jsonb_build_array(
    jsonb_build_object('type','llm','healthy',true),
    jsonb_build_object('type','image','healthy',true),
    jsonb_build_object('type','video','healthy',false)
  ));
  select count(*) into v_n
  from claim_jobs('gpu-1', 't1', '{llm,image}', 8, 60);
  perform assert(v_n = 1, 'image becomes claimable once its service is up');
  perform assert((select status from jobs where type = 'video') = 'queued',
                 'video is still gated');

  -- Passing a type that was never reported cannot widen the live set.
  select count(*) into v_n
  from claim_jobs('gpu-2', 't2', '{llm,image,video}', 8, 60);
  perform assert(v_n = 0,
                 'a worker cannot claim types it has not reported');

  -- An empty list claims nothing; null means every currently healthy report.
  select count(*) into v_n
  from claim_jobs('gpu-1', 't1', '{}', 8, 60);
  perform assert(v_n = 0, 'an empty type list claims nothing');
  perform report_services('gpu-1', 't1', jsonb_build_array(
    jsonb_build_object('type','video','healthy',true)
  ));
  select count(*) into v_n
  from claim_jobs('gpu-1', 't1', null, 8, 60);
  perform assert(v_n = 1, 'a null type list means all healthy reported services');

  insert into jobs(user_id,type,payload) values(
    '11111111-1111-1111-1111-111111111111','image','{"prompt":"stale"}');
  perform report_services('gpu-1', 't1', jsonb_build_array(
    jsonb_build_object('type','image','healthy',true)
  ));
  update worker_services set last_check=now()-interval '91 seconds'
  where worker_id='gpu-1' and type='image';
  select count(*) into v_n
  from claim_jobs('gpu-1', 't1', '{image}', 8, 60);
  perform assert(v_n = 0, 'a stale service report cannot receive work');
end $$;

-- 2b. Direct results require an explicitly advertised worker endpoint -------
do $$
declare v_key text; v_n int;
begin
  truncate jobs cascade;
  select create_api_key('direct-delivery') into v_key;
  perform submit_job(v_key, 'image',
    '{"prompt":"lan only","_result_delivery":"direct"}'::jsonb);

  perform report_services('gpu-1', 't1', jsonb_build_array(
    jsonb_build_object(
      'type','image','healthy',true,
      'parameter_schema',jsonb_build_object(
        '_result_delivery',jsonb_build_object('type','string','enum',jsonb_build_array('cloud'))
      )
    )
  ));
  select count(*) into v_n from pending_by_type('gpu-1','t1');
  perform assert(v_n=0,'cloud-only worker does not see a direct-delivery job');
  select count(*) into v_n from claim_jobs('gpu-1','t1','{image}',1,60);
  perform assert(v_n=0,'cloud-only worker cannot claim a direct-delivery job');

  perform report_services('gpu-1', 't1', jsonb_build_array(
    jsonb_build_object(
      'type','image','healthy',true,
      'parameter_schema',jsonb_build_object(
        '_result_delivery',jsonb_build_object('type','string','enum',jsonb_build_array('cloud','direct'))
      )
    )
  ));
  select count(*) into v_n from pending_by_type('gpu-1','t1');
  perform assert(v_n=1,'direct-capable worker sees direct-delivery demand');
  select count(*) into v_n from claim_jobs('gpu-1','t1','{image}',1,60);
  perform assert(v_n=1,'direct-capable worker claims direct-delivery work');
end $$;

do $$
begin
  begin
    insert into jobs(user_id,type,payload) values(
      '11111111-1111-1111-1111-111111111111','image',
      '{"prompt":"bad delivery","_result_delivery":"unknown"}');
    raise exception 'expected invalid result delivery to fail';
  exception when check_violation then
    perform assert(true,'database rejects unknown result delivery modes');
  end;
  begin
    insert into jobs(user_id,type,payload) values(
      '11111111-1111-1111-1111-111111111111','llm',
      '{"prompt":"inline result","_result_delivery":"direct"}');
    raise exception 'expected direct LLM result to fail';
  exception when check_violation then
    perform assert(true,'database rejects direct delivery for inline LLM results');
  end;
end $$;

-- 3. pending_by_type -------------------------------------------------------
do $$
declare v_key text; v_counts jsonb;
begin
  truncate jobs cascade;
  delete from api_keys;
  perform set_config('request.jwt.claim.sub',
                     '11111111-1111-1111-1111-111111111111', false);
  v_key := create_api_key('k');

  perform submit_job(v_key, 'llm',   '{"prompt":"a"}'::jsonb);
  perform submit_job(v_key, 'llm',   '{"prompt":"b"}'::jsonb);
  perform submit_job(v_key, 'image', '{"prompt":"image"}'::jsonb);

  perform report_services('gpu-1', 't1', jsonb_build_array(
    jsonb_build_object('type','llm','healthy',true),
    jsonb_build_object('type','image','healthy',false)
  ));
  perform report_services('gpu-2', 't2', jsonb_build_array(
    jsonb_build_object('type','image','healthy',false)
  ));

  select jsonb_object_agg(type, n) into v_counts
  from pending_by_type('gpu-1', 't1');
  perform assert((v_counts->>'llm')::int = 2, 'pending_by_type counts llm');
  perform assert((v_counts->>'image')::int = 1, 'pending_by_type counts image');

  -- gpu-2 only reports image, so it must not see llm work. Health does not
  -- matter here because pending demand is also used to start on-demand models.
  select jsonb_object_agg(type, n) into v_counts
  from pending_by_type('gpu-2', 't2');
  perform assert(v_counts->'llm' is null,
                 'pending_by_type respects reported service types');
  perform assert((v_counts->>'image')::int = 1,
                 'gpu-2 sees the image job');
end $$;

-- 4. queue_stats: what the web UI renders ---------------------------------
do $$
declare v_key text; v_stats jsonb;
begin
  truncate jobs cascade;
  delete from worker_services;
  delete from api_keys;
  perform set_config('request.jwt.claim.sub',
                     '11111111-1111-1111-1111-111111111111', false);
  v_key := create_api_key('k');

  perform report_services('gpu-1', 't1', jsonb_build_array(
    jsonb_build_object('type','llm','name','vllm','healthy',true,'capacity',8),
    jsonb_build_object('type','image','name','vllm-omni','healthy',true,'capacity',1)
  ));
  perform report_services('gpu-2', 't2', jsonb_build_array(
    jsonb_build_object('type','image','name','vllm-omni','healthy',false,
                       'detail','loading','capacity',1)
  ));

  perform submit_job(v_key, 'llm', '{"prompt":"a"}'::jsonb);
  perform submit_job(v_key, 'video', '{"prompt":"video"}'::jsonb);

  v_stats := queue_stats();

  -- workers_online means "can actually do work", so gpu-2 — connected but with
  -- its only backend down — is deliberately excluded.
  perform assert((v_stats->>'workers_online')::int = 1,
                 'only workers with a healthy backend count as online');
  perform assert((v_stats->'services'->'llm'->>'up')::int = 1,
                 'one llm backend is up');
  perform assert((v_stats->'services'->'llm'->>'capacity')::int = 8,
                 'llm capacity is reported');
  perform assert((v_stats->'services'->'image'->>'up')::int = 1,
                 'one of two image backends is up');
  perform assert((v_stats->'services'->'image'->>'total')::int = 2,
                 'both image backends are counted');
  perform assert((v_stats->'services'->'llm'->>'queued')::int = 1,
                 'queued llm work is reported');

  -- A type with queued work but no backend at all must still appear, or the UI
  -- cannot explain why the job is not running.
  perform assert(v_stats->'services'->'video' is not null,
                 'a type with no backend still appears');
  perform assert((v_stats->'services'->'video'->>'up')::int = 0,
                 'video shows zero backends up');
  perform assert((v_stats->'services'->'video'->>'queued')::int = 1,
                 'video shows its queued work');
end $$;

-- 5. A stale worker must not be reported as available ----------------------
do $$
declare v_stats jsonb;
begin
  -- Worker stopped heartbeating: its services are no longer trustworthy.
  update workers set last_heartbeat = now() - interval '10 minutes';
  v_stats := queue_stats();
  perform assert((v_stats->>'workers_online')::int = 0,
                 'a worker that stopped heartbeating is not online');
  perform assert((v_stats->'services'->'llm'->>'up')::int = 0,
                 'services of a stale worker are not counted as up');

  update workers set last_heartbeat = now();
  -- Service row itself is stale: the worker is alive but has not re-probed.
  update worker_services set last_check = now() - interval '10 minutes';
  v_stats := queue_stats();
  perform assert((v_stats->'services'->'llm'->>'up')::int = 0,
                 'a stale service report is not counted as up');
end $$;

-- 6. Anonymous callers see counts but no identifying detail ----------------
do $$
declare v_anon jsonb; v_auth jsonb;
begin
  update workers set last_heartbeat = now();
  update worker_services set last_check = now();

  perform set_config('request.jwt.claim.sub', '', true);
  v_anon := queue_stats();
  perform set_config('request.jwt.claim.sub',
                     '11111111-1111-1111-1111-111111111111', true);
  v_auth := queue_stats();

  perform assert((v_anon->>'workers_online')::int > 0,
                 'anon can see how many servers are online');
  perform assert(v_anon->'services'->'llm' is not null,
                 'anon can see per-type availability');
  perform assert(v_anon->'workers'->0->>'id' is null,
                 'anon cannot see worker ids');
  perform assert(v_anon->'workers'->0->'services' = 'null'::jsonb
                 or v_anon->'workers'->0->'services' is null,
                 'anon cannot see per-worker service detail');
  perform assert(v_auth->'workers'->0->>'id' is not null,
                 'signed-in users can see worker ids');
  perform assert(jsonb_array_length(v_auth->'workers'->0->'services') > 0,
                 'signed-in users can see per-worker service detail');
end $$;

-- 7. Deleting a worker cleans up its services ------------------------------
do $$
begin
  delete from workers where id = 'gpu-2';
  perform assert((select count(*) from worker_services
                  where worker_id = 'gpu-2') = 0,
                 'removing a worker removes its service rows');
end $$;

\echo ''
\echo 'All service registry tests passed.'
