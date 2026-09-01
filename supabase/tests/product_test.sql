-- Product foundation regression tests: quotas, retry lineage, retention,
-- worker lifecycle events, webhook claiming and fair scheduling.

\set QUIET on
\pset pager off

\set alice '11111111-1111-1111-1111-111111111111'
\set bob   '22222222-2222-2222-2222-222222222222'

truncate jobs cascade;
delete from worker_events;
delete from worker_services;
delete from workers;
delete from webhooks;
delete from api_keys;
delete from user_profiles;
delete from auth.users;
insert into auth.users(id,email) values
  (:'alice','alice@example.com'),(:'bob','bob@example.com');

-- 1. Product parameters, quota, priority and retention defaults ------------
do $$
declare first_job jobs;
begin
  update user_profiles set max_active_jobs=1,daily_job_limit=2,max_priority=3,retention_days=7
  where user_id='11111111-1111-1111-1111-111111111111';
  if not found then
    insert into user_profiles(user_id,max_active_jobs,daily_job_limit,max_priority,retention_days)
    values('11111111-1111-1111-1111-111111111111',1,2,3,7);
  end if;

  insert into jobs(user_id,type,payload,priority)
  values('11111111-1111-1111-1111-111111111111','llm','{"prompt":"one","temperature":0.3,"max_tokens":2048}',10)
  returning * into first_job;
  perform assert(first_job.priority=3,'ordinary user priority is capped by profile');
  perform assert(first_job.retained_until between now()+interval '6 days 23 hours' and now()+interval '7 days 1 hour',
                 'profile retention is applied at submission');

  begin
    insert into jobs(user_id,type,payload)
    values('11111111-1111-1111-1111-111111111111','llm','{"prompt":"two"}');
    raise exception 'FAIL: active-job quota was not enforced';
  exception when sqlstate '54000' then
    raise notice 'ok  active-job quota is enforced';
  end;

  begin
    insert into jobs(user_id,type,payload)
    values('22222222-2222-2222-2222-222222222222','llm','{"prompt":"bad","temperature":9}');
    raise exception 'FAIL: invalid stable parameter was accepted';
  exception when invalid_parameter_value then
    raise notice 'ok  invalid stable parameters fail before reaching a GPU';
  end;
end $$;

-- 2. Retry creates a new immutable job linked to the old one ---------------
do $$
declare old_id uuid; retried jobs; duplicate jobs;
begin
  update jobs set status='failed',finished_at=now(),error='test failure'
  where user_id='11111111-1111-1111-1111-111111111111'
  returning id into old_id;
  perform assert((select retained_until between now()+interval '6 days 23 hours' and now()+interval '7 days 1 hour' from jobs where id=old_id),
                 'retention restarts when the result becomes terminal');
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',false);
  retried:=retry_job(old_id);
  perform assert(retried.id is not null and retried.id<>old_id,'retry creates a new job');
  perform assert(retried.source_job_id=old_id,'retry records source_job_id');
  perform assert((select status from jobs where id=old_id)='failed','retry preserves old terminal history');
  duplicate:=retry_job(old_id);
  perform assert(duplicate.id is null,'a source job cannot have two active retries');
end $$;

-- 3. Keep and deletion requests are owner-scoped ---------------------------
do $$
declare target uuid;
begin
  select id into target from jobs
  where user_id='11111111-1111-1111-1111-111111111111' and status='failed' limit 1;
  perform set_config('request.jwt.claim.sub','22222222-2222-2222-2222-222222222222',false);
  perform assert(not set_job_retention(target,true),'another user cannot keep a result');
  perform assert(not request_job_deletion(target),'another user cannot delete a result');
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',false);
  perform assert(set_job_retention(target,true),'owner can keep a result');
  perform assert((select keep_result from jobs where id=target),'keep flag is persisted');
  perform assert(request_job_deletion(target),'owner can request terminal result deletion');
  perform assert((select deletion_requested_at is not null from jobs where id=target),'deletion request is persisted');
end $$;

-- 4. Worker parameter declarations and lifecycle events --------------------
insert into workers(id,capabilities,token_hash)
values('gpu-product','{llm,image}',extensions.crypt('worker-token',extensions.gen_salt('bf')));

do $$
declare target uuid;
begin
  insert into jobs(user_id,type,payload) values(
    '22222222-2222-2222-2222-222222222222','llm',
    '{"prompt":"inspect","images":[{"bucket":"inputs","path":"22222222-2222-2222-2222-222222222222/input.png"}]}'
  ) returning id into target;
  update jobs set status='running',worker_id='gpu-product',lease_expires_at=now()+interval '1 minute' where id=target;
  perform assert(worker_input_target('gpu-product','worker-token',target,'inputs','22222222-2222-2222-2222-222222222222/input.png'),
                 'worker can sign an input belonging to the task owner');
  perform assert(not worker_input_target('gpu-product','worker-token',target,'inputs','11111111-1111-1111-1111-111111111111/private.png'),
                 'worker cannot sign another users input even if a payload is forged');
  update jobs set status='canceled',finished_at=now() where id=target;
end $$;

do $$
declare n int;
begin
  perform report_services('gpu-product','worker-token',jsonb_build_array(
    jsonb_build_object('type','llm','healthy',true,'capacity',2,
      'parameter_schema',jsonb_build_object(
        'temperature',jsonb_build_object('min',0,'max',1),
        'max_tokens',jsonb_build_object('min',1,'max',8192))))) ;
  perform assert((select parameter_schema->'temperature'->>'max' from worker_services
                  where worker_id='gpu-product' and type='llm')='1',
                 'worker parameter schema is stored');
  perform assert((select count(*) from worker_events where worker_id='gpu-product' and event='online')=1,
                 'first authenticated heartbeat records online');

  perform report_services('gpu-product','worker-token',jsonb_build_array(
    jsonb_build_object('type','llm','healthy',false,'detail','probe failed')));
  perform assert((select count(*) from worker_events where worker_id='gpu-product' and event='online')=1,
                 'frequent heartbeats do not flood online events');
  perform assert((select count(*) from worker_events where worker_id='gpu-product' and event='service_failed')=1,
                 'healthy-to-failed transition records one service failure');
  perform report_services('gpu-product','worker-token',jsonb_build_array(
    jsonb_build_object('type','llm','healthy',false,'detail','still failed')));
  perform assert((select count(*) from worker_events where worker_id='gpu-product' and event='service_failed')=1,
                 'continued service failure does not flood events');

  update workers set last_heartbeat=now()-interval '2 minutes' where id='gpu-product';
  n:=record_offline_workers();
  perform assert(n=1,'stale online worker records an offline transition');
  perform assert(record_offline_workers()=0,'offline transition is recorded only once');

  update workers set disabled_at=now() where id='gpu-product';
  begin
    perform pending_by_type('gpu-product','worker-token');
    raise exception 'FAIL: disabled worker authenticated';
  exception when invalid_authorization_specification then
    raise notice 'ok  disabled workers are rejected';
  end;
end $$;

-- 5. Maintenance claims are throttled atomically ---------------------------
do $$
begin
  delete from maintenance_runs where name='product-test';
  perform assert(claim_maintenance('product-test',60),'first maintenance caller claims the run');
  perform assert(not claim_maintenance('product-test',60),'second maintenance caller is throttled');
  update maintenance_runs set last_started_at=now()-interval '61 seconds' where name='product-test';
  perform assert(claim_maintenance('product-test',60),'maintenance can run after its interval');
end $$;

-- 5b. Administrator worker lifecycle never exposes stored plaintext -------
do $$
declare created jsonb; rotated text; old_token text;
begin
  insert into admins(user_id) values('11111111-1111-1111-1111-111111111111') on conflict do nothing;
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',false);
  created:=admin_create_worker('admin-gpu','Admin GPU','{}');
  old_token:=created->>'token';
  perform assert(length(old_token)>20,'worker creation returns a one-time token');
  perform assert((select capabilities='{}' from workers where id='admin-gpu'),
                 'worker creation does not require static capabilities');
  perform assert((select token_hash<>old_token and token_hash=extensions.crypt(old_token,token_hash) from workers where id='admin-gpu'),
                 'worker stores only a bcrypt token hash');
  rotated:=admin_rotate_worker_token('admin-gpu');
  perform assert(rotated<>old_token,'token rotation returns a new token');
  begin
    perform pending_by_type('admin-gpu',old_token);
    raise exception 'FAIL: rotated worker token remained valid';
  exception when invalid_authorization_specification then
    raise notice 'ok  rotation revokes the previous worker token';
  end;
  perform assert(admin_revoke_worker('admin-gpu'),'administrator can revoke a worker');
  perform assert((select disabled_at is not null from workers where id='admin-gpu'),'revoked worker is disabled');
  perform assert(admin_set_worker_disabled('admin-gpu',false),'revoked worker can be administratively enabled');
  begin
    perform pending_by_type('admin-gpu',rotated);
    raise exception 'FAIL: enabling a revoked worker restored its old token';
  exception when invalid_authorization_specification then
    raise notice 'ok  enabling a revoked worker does not restore its old token';
  end;
end $$;

-- 6. Terminal events create one webhook delivery and claims do not overlap -
do $$
declare hook uuid; target uuid; first_claim uuid; second_count int;
begin
  insert into webhooks(user_id,url,secret_hash,secret_ciphertext)
  values('22222222-2222-2222-2222-222222222222','https://example.com/jobs','hash','cipher')
  returning id into hook;
  insert into jobs(user_id,type,payload)
  values('22222222-2222-2222-2222-222222222222','tts','{"text":"hello"}') returning id into target;
  update jobs set status='succeeded',result='{"text":"done"}',finished_at=now() where id=target;
  perform assert((select count(*) from job_events where job_id=target and event='job.succeeded')=1,
                 'terminal job emits one event');
  perform assert((select count(*) from webhook_deliveries where webhook_id=hook)=1,
                 'matching webhook receives one delivery');
  select id into first_claim from claim_webhook_deliveries(1);
  perform assert(first_claim is not null,'due webhook delivery can be claimed');
  select count(*) into second_count from claim_webhook_deliveries(1);
  perform assert(second_count=0,'a delivering webhook cannot be claimed twice');
end $$;

-- 7. Batch claim interleaves users instead of filling from one user --------
do $$
declare claimed_users int;
begin
  truncate jobs cascade;
  update workers set disabled_at=null,last_heartbeat=now() where id='gpu-product';
  perform report_services('gpu-product','worker-token',jsonb_build_array(
    jsonb_build_object('type','llm','healthy',true,'capacity',2)));
  update user_profiles set max_active_jobs=100,daily_job_limit=500 where user_id in (
    '11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222');
  insert into jobs(user_id,type,payload,priority) values
    ('11111111-1111-1111-1111-111111111111','llm','{"prompt":"a1"}',5),
    ('11111111-1111-1111-1111-111111111111','llm','{"prompt":"a2"}',5),
    ('11111111-1111-1111-1111-111111111111','llm','{"prompt":"a3"}',5),
    ('22222222-2222-2222-2222-222222222222','llm','{"prompt":"b1"}',0);
  select count(distinct user_id) into claimed_users
  from claim_jobs('gpu-product','worker-token','{llm}',2,60);
  perform assert(claimed_users=2,'first batch gives each waiting user a turn');
end $$;

-- 8. Admin storage metric includes plural and single-file result shapes ----
do $$
declare metrics jsonb;
begin
  truncate jobs cascade;
  insert into jobs(user_id,type,payload) values
    ('11111111-1111-1111-1111-111111111111','image','{"prompt":"image"}'),
    ('22222222-2222-2222-2222-222222222222','tts','{"text":"speech"}');
  update jobs set status='succeeded',finished_at=now(),result=
    case when type='image' then '{"files":[{"bytes":10},{"bytes":20}]}'::jsonb
         else '{"file":{"bytes":30}}'::jsonb end;
  insert into admins(user_id) values('11111111-1111-1111-1111-111111111111') on conflict do nothing;
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',false);
  metrics:=admin_metrics(24);
  perform assert((metrics->>'storage_bytes')::int=60,'storage metric includes file and files result shapes');
end $$;

select 'All product foundation tests passed.' as result;
