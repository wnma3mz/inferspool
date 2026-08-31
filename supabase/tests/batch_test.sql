-- Tests for API keys and batch claim (migration 0002).

\set QUIET on
\pset pager off

\set alice '11111111-1111-1111-1111-111111111111'
\set bob   '22222222-2222-2222-2222-222222222222'

truncate jobs cascade;
delete from api_keys;
delete from workers;
delete from auth.users;

insert into auth.users (id) values (:'alice'), (:'bob');
insert into workers (id, capabilities, token_hash) values
  ('gpu-a', '{llm}',       extensions.crypt('tok-a', extensions.gen_salt('bf'))),
  ('gpu-b', '{llm}',       extensions.crypt('tok-b', extensions.gen_salt('bf')));

-- 1. API key issuance and verification ------------------------------------
do $$
declare
  v_key text;
  v_uid uuid;
begin
  perform set_config('request.jwt.claim.sub',
                     '11111111-1111-1111-1111-111111111111', false);
  v_key := create_api_key('laptop');

  perform assert(v_key like 'inferspool\_%\_%', 'key has the inferspool_prefix_secret shape');
  perform assert((select count(*) from api_keys) = 1, 'key row was created');
  perform assert((select secret_hash from api_keys) like '$2%',
                 'only a bcrypt hash is stored');
  perform assert((select secret_hash from api_keys) <> v_key,
                 'plaintext is not stored');

  v_uid := private.auth_api_key(v_key);
  perform assert(v_uid = '11111111-1111-1111-1111-111111111111'::uuid,
                 'valid key resolves to its owner');
  perform assert((select last_used_at from api_keys) is not null,
                 'using a key records last_used_at');

  -- Tampering with either half must fail.
  perform assert(private.auth_api_key(v_key || 'x') is null,
                 'altered secret is rejected');
  perform assert(private.auth_api_key('inferspool_nosuch_secret') is null,
                 'unknown prefix is rejected');
  perform assert(private.auth_api_key(null) is null, 'null key is rejected');
  perform assert(private.auth_api_key('') is null, 'empty key is rejected');
  perform assert(private.auth_api_key('garbage') is null,
                 'malformed key is rejected');

  -- Revocation.
  update api_keys set revoked_at = now();
  perform assert(private.auth_api_key(v_key) is null, 'revoked key is rejected');
end $$;

-- 2. Anonymous callers cannot mint keys ------------------------------------
do $$
begin
  perform set_config('request.jwt.claim.sub', '', false);
  begin
    perform create_api_key('sneaky');
    raise exception 'FAIL: anonymous caller minted a key';
  exception when sqlstate '28000' then
    raise notice 'ok  anonymous caller cannot mint a key';
  end;
end $$;

-- 3. submit_job via key ----------------------------------------------------
do $$
declare
  v_key text; v_job jobs; v_again jobs;
begin
  truncate jobs cascade;
  delete from api_keys;
  perform set_config('request.jwt.claim.sub',
                     '11111111-1111-1111-1111-111111111111', false);
  v_key := create_api_key('cli');

  v_job := submit_job(v_key, 'llm', '{"prompt":"hi"}'::jsonb);
  perform assert(v_job.user_id = '11111111-1111-1111-1111-111111111111'::uuid,
                 'submitted job belongs to the key owner');
  perform assert(v_job.status = 'queued', 'submitted job starts queued');
  perform assert(v_job.payload->>'prompt' = 'hi', 'payload is stored');

  -- The insert trigger must still sanitise a key-authenticated submission.
  v_job := submit_job(v_key, 'llm', '{"prompt":"p"}'::jsonb, 9999);
  perform assert(v_job.priority = 5, 'ordinary-user priority is clamped to profile limit');

  -- Idempotency returns the original rather than raising.
  v_job  := submit_job(v_key, 'llm', '{"prompt":"a"}'::jsonb, 0, 'dedupe-1');
  v_again := submit_job(v_key, 'llm', '{"prompt":"b"}'::jsonb, 0, 'dedupe-1');
  perform assert(v_job.id = v_again.id,
                 'repeated idempotency key returns the original job');
  perform assert((select count(*) from jobs where idempotency_key = 'dedupe-1') = 1,
                 'no duplicate row is created');

  begin
    perform submit_job('inferspool_bad_key', 'llm', '{}'::jsonb);
    raise exception 'FAIL: submit_job accepted an invalid key';
  exception when sqlstate '28000' then
    raise notice 'ok  submit_job rejects an invalid key';
  end;
end $$;

-- 4. Cross-user isolation through keys -------------------------------------
do $$
declare
  v_alice_key text; v_bob_key text; v_job jobs;
begin
  truncate jobs cascade;
  delete from api_keys;

  perform set_config('request.jwt.claim.sub',
                     '11111111-1111-1111-1111-111111111111', false);
  v_alice_key := create_api_key('alice');
  perform set_config('request.jwt.claim.sub',
                     '22222222-2222-2222-2222-222222222222', false);
  v_bob_key := create_api_key('bob');

  v_job := submit_job(v_alice_key, 'llm', '{"prompt":"secret"}'::jsonb);

  perform assert((select count(*) from list_jobs(v_bob_key)) = 0,
                 'bob sees none of alice''s jobs');
  perform assert((select count(*) from list_jobs(v_alice_key)) = 1,
                 'alice sees her own job');
  perform assert((get_job(v_bob_key, v_job.id)).id is null,
                 'bob cannot read alice''s job by id');
  perform assert(cancel_job_by_key(v_bob_key, v_job.id) is null,
                 'bob cannot cancel alice''s job');
  perform assert((select status from jobs where id = v_job.id) = 'queued',
                 'alice''s job is untouched');
  perform assert(cancel_job_by_key(v_alice_key, v_job.id) = 'canceled',
                 'alice can cancel her own job');
end $$;

-- 5. pending_by_type respects capabilities ----------------------------------
do $$
declare v_key text;
begin
  truncate jobs cascade;
  delete from api_keys;
  perform set_config('request.jwt.claim.sub',
                     '11111111-1111-1111-1111-111111111111', false);
  v_key := create_api_key('k');

  perform submit_job(v_key, 'llm', '{"prompt":"1"}'::jsonb);
  perform submit_job(v_key, 'llm', '{"prompt":"2"}'::jsonb);

  perform assert((select sum(n) from pending_by_type('gpu-a', 'tok-a')) = 2,
                 'gpu-a can see both llm jobs');
  perform assert((select sum(n) from pending_by_type('gpu-b', 'tok-b')) = 2,
                 'gpu-b only counts llm jobs');

  begin
    perform count(*) from pending_by_type('gpu-a', 'wrong');
    raise exception 'FAIL: pending_by_type accepted a bad token';
  exception when sqlstate '28000' then
    raise notice 'ok  pending_by_type requires a valid worker token';
  end;
end $$;

-- 6. removed task types are rejected ----------------------------------------
do $$
declare v_key text;
begin
  delete from api_keys;
  perform set_config('request.jwt.claim.sub',
                     '11111111-1111-1111-1111-111111111111', false);
  v_key := create_api_key('no-embed');
  begin
    perform submit_job(v_key, 'embed', '{"inputs":["x"]}'::jsonb);
    raise exception 'FAIL: removed embed type was accepted';
  exception when check_violation then
    raise notice 'ok  removed embed type is rejected';
  end;
end $$;

-- 7. claim_jobs -------------------------------------------------------------
do $$
declare
  v_key text; v_claimed int; v_lease timestamptz;
begin
  truncate jobs cascade;
  delete from api_keys;
  perform set_config('request.jwt.claim.sub',
                     '11111111-1111-1111-1111-111111111111', false);
  v_key := create_api_key('k');

  for i in 1..10 loop
    perform submit_job(v_key, 'llm', jsonb_build_object('prompt', i::text));
  end loop;

  select count(*) into v_claimed from claim_jobs('gpu-a', 'tok-a', null, 4, 60);
  perform assert(v_claimed = 4, 'claim_jobs honours the limit');
  perform assert((select count(*) from jobs where status = 'running') = 4,
                 'exactly the claimed jobs are running');
  perform assert((select count(*) from jobs where worker_id = 'gpu-a') = 4,
                 'claimed jobs are attributed to the worker');
  perform assert((select bool_and(attempts = 1) from jobs
                  where status = 'running'), 'each claim increments attempts');
  perform assert((select bool_and(lease_expires_at > now()) from jobs
                  where status = 'running'), 'every claimed job has a lease');

  -- A second worker must get different jobs, never the same ones.
  select count(*) into v_claimed from claim_jobs('gpu-b', 'tok-b', null, 4, 60);
  perform assert(v_claimed = 4, 'second worker claims from the remainder');
  perform assert((select count(distinct worker_id) from jobs
                  where status = 'running') = 2, 'both workers hold jobs');
  perform assert((select count(*) from jobs where status = 'running') = 8,
                 'no job was claimed twice');

  -- The batch cap is enforced regardless of what the caller asks for.
  select count(*) into v_claimed from claim_jobs('gpu-a', 'tok-a', null, 9999, 60);
  perform assert(v_claimed = 2, 'claim_jobs cannot exceed the queue');

  begin
    perform claim_jobs('gpu-a', null, null, 4, 60);
    raise exception 'FAIL: claim_jobs accepted a null token';
  exception when sqlstate '28000' then
    raise notice 'ok  claim_jobs rejects a null token';
  end;
end $$;

-- 8. heartbeat_batch renews every lease, and fences foreign jobs -----------
do $$
declare
  v_key text; v_ids uuid[]; v_before timestamptz; v_rows int; v_cancel int;
begin
  truncate jobs cascade;
  delete from api_keys;
  perform set_config('request.jwt.claim.sub',
                     '11111111-1111-1111-1111-111111111111', false);
  v_key := create_api_key('k');

  for i in 1..5 loop
    perform submit_job(v_key, 'llm', jsonb_build_object('prompt', i::text));
  end loop;

  select array_agg(id) into v_ids from claim_jobs('gpu-a', 'tok-a', null, 5, 60);
  select min(lease_expires_at) into v_before from jobs where status = 'running';

  perform pg_sleep(0.05);
  select count(*) into v_rows
  from heartbeat_batch('gpu-a', 'tok-a', v_ids, 300);

  perform assert(v_rows = 5, 'heartbeat_batch renews every job in the batch');
  perform assert((select min(lease_expires_at) from jobs where status = 'running')
                 > v_before, 'all leases moved forward');

  -- A job now owned by someone else must simply be omitted, not stolen back.
  update jobs set worker_id = 'gpu-b' where id = v_ids[1];
  select count(*) into v_rows
  from heartbeat_batch('gpu-a', 'tok-a', v_ids, 300);
  perform assert(v_rows = 4, 'heartbeat_batch omits jobs we no longer own');
  perform assert((select worker_id from jobs where id = v_ids[1]) = 'gpu-b',
                 'the other worker keeps its job');

  -- Cancellation is surfaced per job.
  update jobs set cancel_requested = true where id = v_ids[2];
  select count(*) into v_cancel
  from heartbeat_batch('gpu-a', 'tok-a', v_ids, 300) where cancel_requested;
  perform assert(v_cancel = 1, 'heartbeat_batch reports which jobs were canceled');

  -- Empty input must be harmless.
  select count(*) into v_rows
  from heartbeat_batch('gpu-a', 'tok-a', '{}'::uuid[], 300);
  perform assert(v_rows = 0, 'heartbeat_batch tolerates an empty batch');
end $$;

-- 8. progress_batch --------------------------------------------------------
do $$
declare
  v_key text; v_ids uuid[]; v_n int;
begin
  truncate jobs cascade;
  delete from api_keys;
  perform set_config('request.jwt.claim.sub',
                     '11111111-1111-1111-1111-111111111111', false);
  v_key := create_api_key('k');

  for i in 1..3 loop
    perform submit_job(v_key, 'llm', jsonb_build_object('prompt', i::text));
  end loop;
  select array_agg(id) into v_ids from claim_jobs('gpu-a', 'tok-a', null, 3, 60);

  v_n := progress_batch('gpu-a', 'tok-a', jsonb_build_array(
    jsonb_build_object('id', v_ids[1], 'progress', 0.25, 'msg', 'quarter'),
    jsonb_build_object('id', v_ids[2], 'progress', 0.5,  'msg', 'half')
  ));
  perform assert(v_n = 2, 'progress_batch updates the rows it was given');
  perform assert((select progress from jobs where id = v_ids[1]) = 0.25,
                 'per-job progress is recorded');
  perform assert((select progress_msg from jobs where id = v_ids[2]) = 'half',
                 'per-job message is recorded');
  perform assert((select progress from jobs where id = v_ids[3]) is null,
                 'untouched jobs keep their progress');

  -- A foreign worker must not be able to write progress.
  v_n := progress_batch('gpu-b', 'tok-b', jsonb_build_array(
    jsonb_build_object('id', v_ids[1], 'progress', 0.99, 'msg', 'hijacked')
  ));
  perform assert(v_n = 0, 'progress_batch ignores jobs owned by another worker');
  perform assert((select progress from jobs where id = v_ids[1]) = 0.25,
                 'progress was not hijacked');

  perform assert(progress_batch('gpu-a', 'tok-a', '[]'::jsonb) = 0,
                 'progress_batch tolerates an empty list');
  perform assert(progress_batch('gpu-a', 'tok-a', null) = 0,
                 'progress_batch tolerates null');
end $$;

-- 9. A batch-claimed job still completes and fails correctly ---------------
do $$
declare v_key text; v_ids uuid[];
begin
  truncate jobs cascade;
  delete from api_keys;
  perform set_config('request.jwt.claim.sub',
                     '11111111-1111-1111-1111-111111111111', false);
  v_key := create_api_key('k');

  perform submit_job(v_key, 'llm', '{"prompt":"a"}'::jsonb);
  perform submit_job(v_key, 'llm', '{"prompt":"b"}'::jsonb);
  select array_agg(id) into v_ids from claim_jobs('gpu-a', 'tok-a', null, 2, 60);

  perform complete_job('gpu-a', 'tok-a', v_ids[1], '{"text":"done"}'::jsonb);
  perform assert((select status from jobs where id = v_ids[1]) = 'succeeded',
                 'batch-claimed job completes normally');

  perform fail_job('gpu-a', 'tok-a', v_ids[2], 'oom', true);
  perform assert((select status from jobs where id = v_ids[2]) = 'queued',
                 'batch-claimed job requeues on retryable failure');

  -- And the fencing guard still holds for batch claims.
  begin
    perform complete_job('gpu-b', 'tok-b', v_ids[1], '{"forged":true}'::jsonb);
    raise exception 'FAIL: another worker completed a batch-claimed job';
  exception when sqlstate 'P0002' then
    raise notice 'ok  fencing still applies to batch-claimed jobs';
  end;
end $$;

-- CLI result downloads are scoped to the API key owner and job path.
do $$
declare v_alice_key text; v_bob_key text; v_job jobs; v_path text;
begin
  truncate jobs cascade;
  delete from api_keys;
  perform set_config('request.jwt.claim.sub',
                     '11111111-1111-1111-1111-111111111111', false);
  v_alice_key := create_api_key('download-owner');
  perform set_config('request.jwt.claim.sub',
                     '22222222-2222-2222-2222-222222222222', false);
  v_bob_key := create_api_key('download-other');
  v_job := submit_job(v_alice_key, 'image', '{"prompt":"x"}'::jsonb);
  v_path := v_job.user_id::text || '/' || v_job.id::text || '/result.png';
  perform assert(client_download_target(v_alice_key, v_job.id, 'results', v_path),
                 'owner key may sign its job result');
  perform assert(not client_download_target(v_bob_key, v_job.id, 'results', v_path),
                 'another users key cannot sign the result');
  perform assert(not client_download_target(v_alice_key, v_job.id, 'results',
                                             v_job.user_id::text || '/other/result.png'),
                 'object path must be inside the job directory');
end $$;

\echo ''
\echo 'All batch and API key tests passed.'
