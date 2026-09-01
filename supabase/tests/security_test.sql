-- Regression tests for the bugs found in review. These exercise RLS as a real
-- `authenticated` role: the other suite runs as the table owner, which bypasses
-- RLS entirely and hid several of these.

\set QUIET on
\pset pager off

\set alice '11111111-1111-1111-1111-111111111111'
\set bob   '22222222-2222-2222-2222-222222222222'

truncate jobs cascade;
delete from workers;
delete from auth.users;

insert into auth.users (id) values (:'alice'), (:'bob');
insert into workers (id, token_hash) values
  ('home-gpu', extensions.crypt('secret-a', extensions.gen_salt('bf')));
select report_services('home-gpu', 'secret-a', '[{"type":"image","healthy":true},{"type":"tts","healthy":true}]');

-- Owner must not bypass RLS, or these tests are meaningless.
alter table jobs force row level security;
grant select, insert on jobs to authenticated;

-- 1. Null token must not authenticate (crypt(null,...) is null, and
--    `null or null` is null, which does NOT fire a bare `if ... then raise`).
do $$
begin
  begin
    perform claim_one('home-gpu', null);
    raise exception 'FAIL: null token authenticated as a worker';
  exception when sqlstate '28000' then
    raise notice 'ok  null token rejected';
  end;

  begin
    perform claim_one('home-gpu', '');
    raise exception 'FAIL: empty token authenticated as a worker';
  exception when sqlstate '28000' then
    raise notice 'ok  empty token rejected';
  end;
end $$;

-- 2. Backoff must not overflow. power(2, 44) exceeds an interval, and one such
--    row inside reclaim_expired() would break claim_job for every worker.
do $$
declare v_job jobs;
begin
  truncate jobs cascade;
  insert into jobs (user_id, type, payload) values ('11111111-1111-1111-1111-111111111111', 'image', '{}');

  -- Bypass the sanitize trigger the way only a compromised/owner path could,
  -- to prove reclaim_expired survives hostile values.
  update jobs set status = 'running', attempts = 60,
                  lease_expires_at = now() - interval '1s';
  v_job := claim_one('home-gpu', 'secret-a');
  raise notice 'ok  claim_job survives attempts=60 (no interval overflow)';

  -- Negative attempts cannot even be stored now: the CHECK rejects it, which
  -- is stronger than clamping the backoff after the fact.
  begin
    update jobs set attempts = -1000;
    raise exception 'FAIL: negative attempts was accepted';
  exception when check_violation then
    raise notice 'ok  negative attempts is rejected by the CHECK';
  end;
  perform assert(private.backoff(-1000) >= interval '0',
                 'backoff is still defensive about negative input');
  perform assert(private.backoff(60) = interval '5 minutes',
                 'backoff caps at 5 minutes');
  perform assert(private.backoff(2) = interval '4 seconds',
                 'backoff is exponential for normal attempts');
end $$;

-- 3. Insert sanitisation: a client controls every column except user_id, so
--    the trigger must force queue state back to its initial values.
truncate jobs cascade;
set role authenticated;
select set_config('request.jwt.claim.sub', :'alice', false);

insert into jobs (user_id, type, payload, status, attempts, priority,
                  max_attempts, result, worker_id, cancel_requested)
values ('11111111-1111-1111-1111-111111111111', 'image', '{"prompt":"x"}', 'succeeded', 2147483647,
        2147483647, 2147483647, '{"forged":true}', 'stolen', true);

reset role;

do $$
declare r jobs;
begin
  select * into r from jobs limit 1;
  perform assert(r.status = 'queued',          'forged status reset to queued');
  perform assert(r.attempts = 0,               'forged attempts reset to 0');
  perform assert(r.priority = 0,               'ordinary-user priority forced to fair default');
  perform assert(r.max_attempts = 10,          'max_attempts clamped to 10');
  perform assert(r.result is null,             'forged result cleared');
  perform assert(r.worker_id is null,          'forged worker_id cleared');
  perform assert(r.cancel_requested = false,   'forged cancel flag cleared');
end $$;

-- 4. A user cannot insert a job owned by someone else.
set role authenticated;
select set_config('request.jwt.claim.sub', :'alice', false);
do $$
begin
  begin
    insert into jobs (user_id, type, payload)
    values ('22222222-2222-2222-2222-222222222222', 'image', '{}');
    raise exception 'FAIL: inserted a job for another user';
  exception when insufficient_privilege then
    raise notice 'ok  cannot insert a job for another user';
  end;
end $$;

-- 5. A user sees only their own jobs.
reset role;
truncate jobs cascade;
insert into jobs (user_id, type, payload) values
  ('11111111-1111-1111-1111-111111111111', 'image', '{}'), ('22222222-2222-2222-2222-222222222222', 'image', '{}');

set role authenticated;
select set_config('request.jwt.claim.sub', :'alice', false);
do $$
begin
  perform assert((select count(*) from jobs) = 1, 'RLS hides other users jobs');
end $$;

-- 6. request_cancel must work for a real user. As SECURITY INVOKER with no
--    UPDATE policy this silently updated zero rows: the Cancel button was dead.
do $$
declare v_id uuid; v_status public.job_status;
begin
  select id into v_id from jobs limit 1;
  v_status := request_cancel(v_id);
  perform assert(v_status = 'canceled',
                 'request_cancel works as an authenticated user');
  perform assert((select status from jobs where id = v_id) = 'canceled',
                 'canceled status is persisted');
end $$;

-- 7. A user cannot cancel someone else's job.
do $$
declare v_other uuid;
begin
  perform set_config('request.jwt.claim.sub',
                     '22222222-2222-2222-2222-222222222222', false);
  select id into v_other from jobs limit 1;   -- bob's own job
  perform set_config('request.jwt.claim.sub',
                     '11111111-1111-1111-1111-111111111111', false);
  perform assert(request_cancel(v_other) is null,
                 'cannot cancel another users job');
end $$;

-- 8. A user cannot UPDATE jobs directly (no UPDATE policy at all).
do $$
begin
  begin
    update jobs set status = 'succeeded';
    -- RLS filters rather than errors, so assert nothing changed.
    perform assert(not exists (select 1 from jobs where status = 'succeeded'),
                   'direct UPDATE cannot forge success');
  exception when insufficient_privilege then
    raise notice 'ok  direct UPDATE denied outright';
  end;
end $$;

-- 9. Worker token hashes are invisible to clients.
do $$
begin
  begin
    perform count(*) from workers;
    perform assert((select count(*) from workers) = 0,
                   'workers table exposes no rows to clients');
  exception when insufficient_privilege then
    raise notice 'ok  workers table denied outright';
  end;
end $$;

reset role;

-- 10. Cancel + worker death must not strand a job in queued forever.
do $$
declare v_id uuid; v_job jobs;
begin
  truncate jobs cascade;
  insert into jobs (user_id, type, payload)
  values ('11111111-1111-1111-1111-111111111111', 'image', '{}') returning id into v_id;

  v_job := claim_one('home-gpu', 'secret-a');
  update jobs set cancel_requested = true where id = v_id;   -- user cancels
  update jobs set lease_expires_at = now() - interval '1s' where id = v_id;

  v_job := claim_one('home-gpu', 'secret-a');   -- triggers reclaim
  perform assert((select status from jobs where id = v_id) = 'canceled',
                 'canceled job whose worker died ends canceled, not queued');
  perform assert((select finished_at from jobs where id = v_id) is not null,
                 'stranded-cancel job gets finished_at so the UI stops polling');
end $$;

-- 11. fail_job must not clobber a job that another worker now owns.
do $$
declare v_id uuid; v_job jobs;
begin
  truncate jobs cascade;
  delete from workers;
  insert into workers (id, token_hash) values
    ('w1', extensions.crypt('t1', extensions.gen_salt('bf'))),
    ('w2', extensions.crypt('t2', extensions.gen_salt('bf')));
  perform report_services('w1', 't1', '[{"type":"image","healthy":true}]');
  perform report_services('w2', 't2', '[{"type":"image","healthy":true}]');

  insert into jobs (user_id, type, payload)
  values ('11111111-1111-1111-1111-111111111111', 'image', '{}') returning id into v_id;

  v_job := claim_one('w1', 't1');
  -- w1 stalls; lease lapses; w2 takes over.
  update jobs set lease_expires_at = now() - interval '1s' where id = v_id;
  v_job := claim_one('w2', 't2');
  update jobs set can_start_at = now() where id = v_id;
  v_job := claim_one('w2', 't2');
  perform assert(v_job.worker_id = 'w2', 'w2 owns the job');

  -- w1 wakes up and reports failure. It must be refused, not requeue w2's job.
  begin
    perform fail_job('w1', 't1', v_id, 'stale oom', true);
    raise exception 'FAIL: stale fail_job requeued a job owned by another worker';
  exception when sqlstate 'P0002' then
    raise notice 'ok  stale fail_job refused';
  end;

  perform assert((select status from jobs where id = v_id) = 'running',
                 'job stays running with its real owner');
  perform assert((select worker_id from jobs where id = v_id) = 'w2',
                 'real owner is untouched');
end $$;

-- 12. fail_job must not resurrect an already-succeeded job.
do $$
declare v_id uuid; v_job jobs;
begin
  truncate jobs cascade;
  insert into jobs (user_id, type, payload)
  values ('11111111-1111-1111-1111-111111111111', 'image', '{}') returning id into v_id;

  v_job := claim_one('w1', 't1');
  perform complete_job('w1', 't1', v_id, '{"key":"out/real.png"}'::jsonb);

  begin
    perform fail_job('w1', 't1', v_id, 'late failure', true);
    raise exception 'FAIL: fail_job resurrected a completed job';
  exception when sqlstate 'P0002' then
    raise notice 'ok  fail_job cannot resurrect a completed job';
  end;

  perform assert((select status from jobs where id = v_id) = 'succeeded',
                 'completed job stays succeeded');
  perform assert((select result->>'key' from jobs where id = v_id) = 'out/real.png',
                 'result is preserved');
end $$;

-- 13. queue_stats must not leak worker ids to anonymous callers.
do $$
declare v_anon jsonb; v_auth jsonb;
begin
  perform set_config('request.jwt.claim.sub', '', true);
  v_anon := queue_stats();
  perform set_config('request.jwt.claim.sub',
                     '11111111-1111-1111-1111-111111111111', true);
  v_auth := queue_stats();

  perform assert(v_anon->'workers'->0->>'id' is null,
                 'anon does not see worker ids');
  perform assert(v_auth->'workers'->0->>'id' is not null,
                 'authenticated users do see worker ids');
  perform assert((v_anon->'workers'->0->>'online') in ('true','false'),
                 'online is a real boolean, never null');
end $$;

-- 14. Admin APIs cross user boundaries, but ordinary users cannot.
reset role;
truncate jobs cascade;
delete from admins;
insert into admins (user_id) values (:'alice');
insert into jobs (user_id, type, payload) values
  (:'alice', 'image', '{"prompt":"a"}'),
  (:'bob', 'llm', '{"prompt":"b"}');

set role authenticated;
select set_config('request.jwt.claim.sub', :'bob', false);
do $$
begin
  perform assert(not is_admin(), 'ordinary user is not an admin');
  begin
    perform count(*) from admin_list_jobs();
    raise exception 'FAIL: ordinary user listed all jobs';
  exception when insufficient_privilege then
    raise notice 'ok  ordinary user cannot use admin APIs';
  end;
end $$;

select set_config('request.jwt.claim.sub', :'alice', false);
do $$
declare v_bob uuid; v_job jobs;
begin
  perform assert(is_admin(), 'admin membership is reported');
  perform assert((select count(*) from admin_list_jobs()) = 2,
                 'admin sees jobs belonging to every user');
  select id into v_bob from admin_list_jobs() where user_id =
    '22222222-2222-2222-2222-222222222222';
  perform assert(admin_cancel_job(v_bob) = 'canceled',
                 'admin can cancel another users queued job');
  v_job := admin_retry_job(v_bob);
  perform assert(v_job.status = 'queued' and v_job.attempts = 0,
                 'admin can retry a terminal job');
  perform assert(admin_retry_job(v_bob) is null,
                 'admin cannot retry a live job');
end $$;

-- 15. Upload authorization is fenced by worker ownership and lease.
reset role;
truncate jobs cascade;
delete from workers;
insert into workers (id, token_hash) values
  ('uploader', extensions.crypt('upload-secret', extensions.gen_salt('bf')));
select report_services('uploader', 'upload-secret', '[{"type":"image","healthy":true}]');
do $$
declare v_id uuid; v_job jobs;
begin
  insert into jobs (user_id, type, payload) values
    ('11111111-1111-1111-1111-111111111111', 'image', '{}') returning id into v_id;
  v_job := claim_one('uploader', 'upload-secret');
  perform assert((select count(*) from worker_upload_target(
    'uploader', 'upload-secret', v_id)) = 1,
    'current worker owner may request an upload');
  update jobs set lease_expires_at = now() - interval '1s' where id = v_id;
  perform assert((select count(*) from worker_upload_target(
    'uploader', 'upload-secret', v_id)) = 0,
    'expired worker lease cannot request an upload');
end $$;

-- 16. The product API uses its service-role client to reach RPCs that perform
-- their own API-key or worker-token authentication.
do $$
declare signature text;
begin
  foreach signature in array array[
    'public.queue_stats()',
    'public.submit_job(text,text,jsonb,integer,text)',
    'public.cancel_job_by_key(text,uuid)',
    'public.retry_job_by_key(text,uuid)',
    'public.claim_jobs(text,text,text[],integer,integer)',
    'public.heartbeat_batch(text,text,uuid[],integer)',
    'public.progress_batch(text,text,jsonb)',
    'public.complete_job(text,text,uuid,jsonb)',
    'public.fail_job(text,text,uuid,text,boolean)',
    'public.report_services(text,text,jsonb)',
    'public.pending_by_type(text,text)',
    'public.reclaim_expired_jobs()'
  ] loop
    perform assert(has_function_privilege('service_role', signature, 'EXECUTE'),
                   'product API may execute ' || signature);
  end loop;
end $$;

do $$
declare privilege text;
begin
  foreach privilege in array array[
    'jobs:SELECT', 'jobs:INSERT', 'jobs:UPDATE', 'jobs:DELETE',
    'api_keys:SELECT', 'api_keys:UPDATE',
    'worker_services:SELECT', 'workers:SELECT', 'job_events:SELECT'
  ] loop
    perform assert(
      has_table_privilege('service_role', split_part(privilege, ':', 1), split_part(privilege, ':', 2)),
      'product API has ' || privilege
    );
  end loop;
end $$;

\echo ''
\echo 'All security tests passed.'
