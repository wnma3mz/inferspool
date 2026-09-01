-- Behavioural tests for the queue. Run with:
--   psql -v ON_ERROR_STOP=1 -d inferspool_test -f supabase/tests/queue_test.sql
-- Any failure raises and aborts.

\set QUIET on
\pset pager off


-- Fixtures -----------------------------------------------------------------
truncate jobs cascade;
delete from workers;
delete from auth.users;

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');

insert into workers (id, token_hash) values
  ('home-gpu', extensions.crypt('secret-a', extensions.gen_salt('bf'))),
  ('other-gpu', extensions.crypt('secret-b', extensions.gen_salt('bf')));
select report_services('home-gpu', 'secret-a', '[{"type":"image","healthy":true},{"type":"tts","healthy":true}]');
select report_services('other-gpu', 'secret-b', '[{"type":"image","healthy":true}]');

-- 1. Auth ------------------------------------------------------------------
do $$
begin
  begin
    perform claim_one('home-gpu', 'wrong-token');
    raise exception 'FAIL: bad token was accepted';
  exception when sqlstate '28000' then
    raise notice 'ok  bad token rejected';
  end;

  begin
    perform claim_one('ghost-gpu', 'secret-a');
    raise exception 'FAIL: unknown worker was accepted';
  exception when sqlstate '28000' then
    raise notice 'ok  unknown worker rejected';
  end;
end $$;

-- 2. Empty queue returns null rather than erroring -------------------------
do $$
declare v_job jobs;
begin
  v_job := claim_one('home-gpu', 'secret-a');
  perform assert(v_job.id is null, 'empty queue yields null');
end $$;

-- 3. Reported-service routing ---------------------------------------------
do $$
declare
  v_tts uuid;
  v_job jobs;
begin
  insert into jobs (user_id, type, payload)
  values ('11111111-1111-1111-1111-111111111111', 'tts', '{"text":"hi"}')
  returning id into v_tts;

  -- other-gpu only reports image, so it must not see the tts job.
  v_job := claim_one('other-gpu', 'secret-b');
  perform assert(v_job.id is null, 'worker skips jobs without a reported service');

  v_job := claim_one('home-gpu', 'secret-a');
  perform assert(v_job.id = v_tts, 'worker with a healthy reported service claims the job');
  perform assert(v_job.status = 'running', 'claimed job is running');
  perform assert(v_job.attempts = 1, 'claim increments attempts');
  perform assert(v_job.lease_expires_at > now(), 'claim sets a lease');
end $$;

-- 4. Ordinary jobs use FIFO ordering --------------------------------------
do $$
declare
  v_lo uuid; v_hi uuid; v_job jobs;
begin
  truncate jobs cascade;
  insert into jobs (user_id, type, priority, payload)
  values ('11111111-1111-1111-1111-111111111111', 'image', 0, '{}')
  returning id into v_lo;
  perform pg_sleep(0.01);
  insert into jobs (user_id, type, priority, payload)
  values ('11111111-1111-1111-1111-111111111111', 'image', 10, '{}')
  returning id into v_hi;

  v_job := claim_one('home-gpu', 'secret-a');
  perform assert(v_job.id = v_lo, 'ordinary user jobs remain FIFO');
  v_job := claim_one('home-gpu', 'secret-a');
  perform assert(v_job.id = v_hi, 'later job is claimed second');
end $$;

-- 5. Idempotency -----------------------------------------------------------
do $$
begin
  truncate jobs cascade;
  insert into jobs (user_id, type, idempotency_key, payload)
  values ('11111111-1111-1111-1111-111111111111', 'image', 'dbl-click', '{}');

  begin
    insert into jobs (user_id, type, idempotency_key, payload)
    values ('11111111-1111-1111-1111-111111111111', 'image', 'dbl-click', '{}');
    raise exception 'FAIL: duplicate idempotency_key accepted';
  exception when unique_violation then
    raise notice 'ok  duplicate idempotency_key rejected';
  end;

  -- Same key, different user: must be allowed.
  insert into jobs (user_id, type, idempotency_key, payload)
  values ('22222222-2222-2222-2222-222222222222', 'image', 'dbl-click', '{}');
  raise notice 'ok  idempotency_key scoped per user';

  -- Null keys must not collide with each other.
  insert into jobs (user_id, type, payload)
  values ('11111111-1111-1111-1111-111111111111', 'image', '{}'),
         ('11111111-1111-1111-1111-111111111111', 'image', '{}');
  raise notice 'ok  null idempotency_key does not collide';
end $$;

-- 6. Happy path: heartbeat then complete ----------------------------------
do $$
declare
  v_id uuid; v_job jobs; v_hb record;
begin
  truncate jobs cascade;
  insert into jobs (user_id, type, payload)
  values ('11111111-1111-1111-1111-111111111111', 'image', '{}') returning id into v_id;

  v_job := claim_one('home-gpu', 'secret-a', 60);

  select * into v_hb from heartbeat_batch('home-gpu', 'secret-a',
                                          array[v_id], 120);
  perform assert(v_hb.cancel_requested = false, 'heartbeat reports no cancellation');
  perform assert((select lease_expires_at from jobs where id = v_id)
                 > v_job.lease_expires_at, 'heartbeat extends lease');
  perform progress_batch('home-gpu', 'secret-a', jsonb_build_array(
    jsonb_build_object('id', v_id, 'progress', 0.5, 'msg', 'step 10/20')));
  perform assert((select progress from jobs where id = v_id) = 0.5,
                 'progress_batch records progress');

  perform complete_job('home-gpu', 'secret-a', v_id, '{"key":"out/a.png"}'::jsonb);
  perform assert((select status from jobs where id = v_id) = 'succeeded',
                 'complete marks succeeded');
  perform assert((select progress from jobs where id = v_id) = 1,
                 'complete sets progress to 1');
  perform assert((select finished_at from jobs where id = v_id) is not null,
                 'complete stamps finished_at');
end $$;

-- 7. Power cut: expired lease is reclaimed by the next claim ---------------
do $$
declare v_id uuid; v_job jobs;
begin
  truncate jobs cascade;
  insert into jobs (user_id, type, payload)
  values ('11111111-1111-1111-1111-111111111111', 'image', '{}') returning id into v_id;

  v_job := claim_one('home-gpu', 'secret-a', 60);
  -- Simulate the worker vanishing mid-job.
  update jobs set lease_expires_at = now() - interval '1 second' where id = v_id;

  -- Backoff means it is not instantly claimable...
  v_job := claim_one('home-gpu', 'secret-a');
  perform assert(v_job.id is null, 'reclaimed job respects backoff');
  perform assert((select status from jobs where id = v_id) = 'queued',
                 'expired lease returns job to queue');
  perform assert((select worker_id from jobs where id = v_id) is null,
                 'reclaim clears worker_id');
  perform assert((select error from jobs where id = v_id)
                 like 'worker lost; lease expired after attempt 1; retry scheduled',
                 'requeued job exposes why the attempt was lost');

  -- ...but is picked up once backoff elapses.
  update jobs set can_start_at = now() where id = v_id;
  v_job := claim_one('home-gpu', 'secret-a');
  perform assert(v_job.id = v_id, 'job is retried after backoff');
  perform assert(v_job.attempts = 2, 'retry increments attempts');
end $$;

-- 8. Zombie worker cannot touch a job that moved on ------------------------
do $$
declare v_id uuid; v_job jobs;
begin
  truncate jobs cascade;
  insert into jobs (user_id, type, payload)
  values ('11111111-1111-1111-1111-111111111111', 'image', '{}') returning id into v_id;

  v_job := claim_one('home-gpu', 'secret-a', 60);
  -- home-gpu stalls, lease lapses, other-gpu takes over.
  update jobs set lease_expires_at = now() - interval '1 second' where id = v_id;
  v_job := claim_one('other-gpu', 'secret-b');   -- reclaims, then claims
  update jobs set can_start_at = now() where id = v_id;
  v_job := claim_one('other-gpu', 'secret-b');
  perform assert(v_job.id = v_id, 'second worker takes over the job');

  -- The original worker wakes up and tries to finish. It must be refused.
  begin
    perform complete_job('home-gpu', 'secret-a', v_id, '{"stale":true}'::jsonb);
    raise exception 'FAIL: zombie worker completed a reassigned job';
  exception when sqlstate 'P0002' then
    raise notice 'ok  zombie complete_job refused';
  end;

  -- heartbeat_batch omits jobs we no longer own; the client treats an absent
  -- row as "lease lost".
  perform assert(not exists (
    select 1 from heartbeat_batch('home-gpu', 'secret-a', array[v_id], 60)),
    'zombie heartbeat renews nothing');

  perform assert((select result from jobs where id = v_id) is null,
                 'zombie did not overwrite result');
end $$;

-- 8b. API maintenance reclaims a lost worker without another claim --------
do $$
declare v_id uuid; v_job jobs; v_reclaimed int;
begin
  truncate jobs cascade;
  insert into jobs (user_id, type, payload)
  values ('11111111-1111-1111-1111-111111111111', 'image', '{}') returning id into v_id;

  v_job := claim_one('home-gpu', 'secret-a', 60);
  update jobs set lease_expires_at = now() - interval '1 second' where id = v_id;
  v_reclaimed := reclaim_expired_jobs();
  perform assert(v_reclaimed = 1, 'maintenance reports one reclaimed lease');
  perform assert((select status from jobs where id = v_id) = 'queued',
                 'maintenance requeues a lost worker attempt');
  perform assert((select error from jobs where id = v_id)
                 like 'worker lost; lease expired%retry scheduled',
                 'maintenance records the lost worker error');
end $$;

-- 9. Retry exhaustion -----------------------------------------------------
do $$
declare v_id uuid; v_job jobs;
begin
  truncate jobs cascade;
  insert into jobs (user_id, type, payload, max_attempts)
  values ('11111111-1111-1111-1111-111111111111', 'image', '{}', 2) returning id into v_id;

  v_job := claim_one('home-gpu', 'secret-a');
  perform fail_job('home-gpu', 'secret-a', v_id, 'cuda oom', true);
  perform assert((select status from jobs where id = v_id) = 'queued',
                 'retryable failure requeues while attempts remain');

  update jobs set can_start_at = now() where id = v_id;
  v_job := claim_one('home-gpu', 'secret-a');
  perform assert(v_job.attempts = 2, 'second attempt recorded');
  perform fail_job('home-gpu', 'secret-a', v_id, 'cuda oom', true);
  perform assert((select status from jobs where id = v_id) = 'failed',
                 'failure at max_attempts marks failed');
  perform assert((select error from jobs where id = v_id) = 'cuda oom',
                 'error message preserved');
end $$;

-- 10. Non-retryable failure fails immediately ------------------------------
do $$
declare v_id uuid; v_job jobs;
begin
  truncate jobs cascade;
  insert into jobs (user_id, type, payload, max_attempts)
  values ('11111111-1111-1111-1111-111111111111', 'image', '{}', 5) returning id into v_id;

  v_job := claim_one('home-gpu', 'secret-a');
  perform fail_job('home-gpu', 'secret-a', v_id, 'bad prompt', false);
  perform assert((select status from jobs where id = v_id) = 'failed',
                 'non-retryable failure skips remaining attempts');
end $$;

-- 11. Lease expiry past max_attempts goes to failed, not queued ------------
do $$
declare v_id uuid; v_job jobs;
begin
  truncate jobs cascade;
  insert into jobs (user_id, type, payload, max_attempts)
  values ('11111111-1111-1111-1111-111111111111', 'image', '{}', 1) returning id into v_id;

  v_job := claim_one('home-gpu', 'secret-a');
  update jobs set lease_expires_at = now() - interval '1 second' where id = v_id;
  v_job := claim_one('home-gpu', 'secret-a');
  perform assert((select status from jobs where id = v_id) = 'failed',
                 'exhausted job is failed, not requeued forever');
  perform assert((select error from jobs where id = v_id)
                 like 'worker lost; lease expired%retries exhausted',
                 'reclaim records why it failed');
end $$;

-- 12. Cancellation ---------------------------------------------------------
-- request_cancel is scoped to auth.uid(), so a caller identity is required
-- even when running as the table owner.
select set_config('request.jwt.claim.sub',
                  '11111111-1111-1111-1111-111111111111', false);

do $$
declare v_id uuid; v_job jobs; v_hb record;
begin
  truncate jobs cascade;

  -- Queued: canceled outright.
  insert into jobs (user_id, type, payload)
  values ('11111111-1111-1111-1111-111111111111', 'image', '{}') returning id into v_id;
  perform assert(request_cancel(v_id) = 'canceled', 'queued job cancels immediately');
  v_job := claim_one('home-gpu', 'secret-a');
  perform assert(v_job.id is null, 'canceled job is never claimed');

  -- Running: flagged, worker learns via heartbeat.
  insert into jobs (user_id, type, payload)
  values ('11111111-1111-1111-1111-111111111111', 'image', '{}') returning id into v_id;
  v_job := claim_one('home-gpu', 'secret-a');
  perform assert(request_cancel(v_id) = 'running', 'running job stays running when canceled');

  select * into v_hb from heartbeat_batch('home-gpu', 'secret-a',
                                          array[v_id], 60);
  perform assert(v_hb.cancel_requested, 'heartbeat surfaces cancel request');

  perform fail_job('home-gpu', 'secret-a', v_id, 'canceled by user', true);
  perform assert((select status from jobs where id = v_id) = 'canceled',
                 'canceled job ends canceled, not requeued');
end $$;

-- 13. Realtime broadcast fires on plain SQL writes -------------------------
do $$
declare v_id uuid; v_before bigint;
begin
  truncate jobs cascade;
  select count(*) into v_before from realtime.messages;
  insert into jobs (user_id, type, payload)
  values ('11111111-1111-1111-1111-111111111111', 'image', '{}') returning id into v_id;
  perform assert((select count(*) from realtime.messages) > v_before,
                 'insert broadcasts to realtime');

  select count(*) into v_before from realtime.messages;
  update jobs set progress = 0.9 where id = v_id;
  perform assert((select count(*) from realtime.messages) > v_before,
                 'plain SQL update broadcasts to realtime');
  -- Two topics per write: per-job for the detail view, per-user for the list
  -- view (Realtime matches channel names exactly, so a list view needs its own).
  perform assert(exists (select 1 from realtime.messages
                         where topic = 'job:' || v_id::text),
                 'broadcast includes a per-job topic');
  perform assert(exists (select 1 from realtime.messages
                         where topic = 'user:11111111-1111-1111-1111-111111111111'),
                 'broadcast includes a per-user topic');
end $$;

-- 14. queue_stats ----------------------------------------------------------
do $$
declare v_stats jsonb; v_job jobs;
begin
  truncate jobs cascade;
  insert into jobs (user_id, type, payload)
  values ('11111111-1111-1111-1111-111111111111', 'image', '{}'),
         ('11111111-1111-1111-1111-111111111111', 'image', '{}');
  v_job := claim_one('home-gpu', 'secret-a');

  v_stats := queue_stats();
  perform assert((v_stats->>'queued')::int = 1,  'queue_stats counts queued');
  perform assert((v_stats->>'running')::int = 1, 'queue_stats counts running');
  perform assert(jsonb_array_length(v_stats->'workers') = 2, 'queue_stats lists workers');
  perform assert(
    (select bool_or((w->>'online')::boolean) from jsonb_array_elements(v_stats->'workers') w),
    'queue_stats marks a heartbeating worker online');
end $$;

\echo ''
\echo 'All queue tests passed.'
