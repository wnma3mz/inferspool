-- inferspool schema: cloud queue + home GPU workers pulling over HTTPS.
--
-- Design notes:
--   * `jobs` is the single source of truth: queue state AND user-facing
--     history. No separate queue, so no two-sources-of-truth problem.
--   * Workers never get database credentials. They call the RPCs below with
--     the anon key plus their own token, verified inside SECURITY DEFINER
--     functions. Helpers live in `private`, which PostgREST does not expose.
--   * Expired leases are reclaimed at the top of claim_jobs, so there is no
--     cron job to maintain: it runs exactly when it needs to have run.
--   * Clients authenticate either with a Supabase session (web) or an API key
--     (CLI). Both end up owning rows in the same table.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;

create type job_status as enum ('queued', 'running', 'succeeded', 'failed',
                                'canceled');

-- Job types are constrained so a typo fails at submit time rather than after
-- burning every retry on a job no worker can handle.
create domain job_type as text
  check (value in ('image', 'video', 'tts', 'llm'));

create table jobs (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid()
                     references auth.users (id) on delete cascade,
  type             job_type not null,
  status           job_status not null default 'queued',
  priority         int not null default 0,
  payload          jsonb not null default '{}'::jsonb,
  result           jsonb,
  progress         real,
  progress_msg     text,
  error            text,
  idempotency_key  text,
  attempts         int not null default 0,
  max_attempts     int not null default 3,
  worker_id        text,
  lease_expires_at timestamptz,
  cancel_requested boolean not null default false,
  can_start_at     timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  constraint jobs_attempts_sane check (attempts >= 0 and max_attempts >= 1)
);

-- Partial indexes: they stay small because they only cover live rows, not the
-- ever-growing history.
create unique index jobs_idem_uniq on jobs (user_id, idempotency_key)
  where idempotency_key is not null;
-- priority/can_start_at lead so the ORDER BY is satisfied by the index even
-- when a worker declares several capabilities; type trails as a filter. With
-- type leading, a multi-capability worker seq-scans and sorts on every poll.
create index jobs_queue_idx on jobs (priority desc, can_start_at, type)
  where status = 'queued';
create index jobs_lease_idx on jobs (lease_expires_at)
  where status = 'running';
create index jobs_user_idx on jobs (user_id, created_at desc);

create table workers (
  id             text primary key,
  capabilities   text[] not null default '{}',
  token_hash     text not null,
  last_heartbeat timestamptz,
  note           text,
  created_at     timestamptz not null default now()
);

-- One row per HTTP inference backend a worker fronts. Probed independently, so
-- a worker whose image backend is down can still take LLM work.
create table worker_services (
  worker_id   text not null references workers (id) on delete cascade,
  type        text not null,
  name        text,                    -- 'vllm', 'vllm-omni' …
  healthy     boolean not null default false,
  detail      text,                    -- why it is unhealthy
  models      text[] not null default '{}',
  capacity    int not null default 1,  -- concurrent jobs this backend accepts
  last_check  timestamptz not null default now(),
  primary key (worker_id, type)
);

create index worker_services_healthy_idx on worker_services (type)
  where healthy;

-- API keys, so a CLI on any machine can submit without an interactive login.
-- Format: inferspool_<prefix>_<secret>. The prefix is stored in the clear and
-- indexed, so verification is one bcrypt against one candidate row.
create table api_keys (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  prefix       text not null unique,
  secret_hash  text not null,
  label        text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

create index api_keys_user_idx on api_keys (user_id, created_at desc);

-- Row level security ---------------------------------------------------------
-- Users touch their own rows only. Worker RPCs are SECURITY DEFINER and bypass
-- these, so nothing here needs to accommodate workers.

alter table jobs enable row level security;
alter table workers enable row level security;
alter table worker_services enable row level security;
alter table api_keys enable row level security;

create policy "own jobs readable" on jobs
  for select to authenticated using (user_id = auth.uid());

create policy "own jobs insertable" on jobs
  for insert to authenticated with check (user_id = auth.uid());

-- Deliberately no UPDATE policy on jobs. A `with check (cancel_requested)`
-- policy would still let a client rewrite status or payload in the same
-- statement, so cancellation goes through request_cancel() instead.

-- No policies on workers or worker_services: they hold token hashes and
-- backend detail, and are reachable only through queue_stats(), which redacts
-- identifying fields for anonymous callers.

create policy "own keys readable" on api_keys
  for select to authenticated using (user_id = auth.uid());

-- Revocation only. Without the immutability trigger below, an UPDATE policy
-- would also let a client rewrite prefix/secret_hash or un-revoke a key.
create policy "own keys revocable" on api_keys
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Column guards ---------------------------------------------------------------

-- The INSERT policy can only constrain user_id, so every other column is
-- client-supplied. Force queue state to its initial values, otherwise a client
-- could insert status='succeeded' to fake history, or attempts=-1000 /
-- priority=2147483647 to abuse the scheduler.
create or replace function private.sanitize_job()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.status           := 'queued';
  new.attempts         := 0;
  new.worker_id        := null;
  new.lease_expires_at := null;
  new.result           := null;
  new.progress         := null;
  new.progress_msg     := null;
  new.error            := null;
  new.cancel_requested := false;
  new.started_at       := null;
  new.finished_at      := null;
  new.can_start_at     := greatest(coalesce(new.can_start_at, now()), now());
  new.priority         := least(greatest(coalesce(new.priority, 0), 0), 10);
  new.max_attempts     := least(greatest(coalesce(new.max_attempts, 3), 1), 10);
  return new;
end;
$$;

create trigger jobs_sanitize
  before insert on jobs
  for each row execute function private.sanitize_job();

-- An API key is issued once and thereafter only revocable. Everything else is
-- pinned here, since the RLS policy above cannot restrict columns.
create or replace function private.freeze_api_key()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.id          := old.id;
  new.user_id     := old.user_id;
  new.prefix      := old.prefix;
  new.secret_hash := old.secret_hash;
  new.created_at  := old.created_at;
  -- last_used_at is deliberately not frozen: auth_api_key() stamps it on every
  -- use, and it carries no authority.
  -- Revoking is one-way: a client cannot restore a key it has given away.
  new.revoked_at  := coalesce(old.revoked_at, new.revoked_at);
  return new;
end;
$$;

create trigger api_keys_freeze
  before update on api_keys
  for each row execute function private.freeze_api_key();

-- Authentication --------------------------------------------------------------

create or replace function private.auth_worker(p_worker_id text, p_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash text;
begin
  select token_hash into v_hash from public.workers where id = p_worker_id;

  -- Always run crypt(), even for an unknown worker, so response time does not
  -- reveal which worker ids exist.
  if v_hash is null then
    perform extensions.crypt(coalesce(p_token, ''),
                             extensions.gen_salt('bf', 12));
    raise exception 'bad worker credentials' using errcode = '28000';
  end if;

  -- p_token must be checked for null explicitly: crypt(null, ...) returns
  -- null, so `v_hash <> null` is null and `if null then` would NOT raise,
  -- letting a caller authenticate as any worker by sending a null token.
  if p_token is null or v_hash <> extensions.crypt(p_token, v_hash) then
    raise exception 'bad worker credentials' using errcode = '28000';
  end if;

  update public.workers set last_heartbeat = now() where id = p_worker_id;
end;
$$;

revoke all on function private.auth_worker(text, text)
  from public, anon, authenticated;

-- Resolve an API key to its owner, or null. Returns rather than raises so
-- callers choose between 401 and a quieter failure.
create or replace function private.auth_api_key(p_key text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prefix text;
  v_secret text;
  v_row    public.api_keys;
begin
  if p_key is null then
    return null;
  end if;

  -- inferspool_<prefix>_<secret>. The secret is base64 with '+/=' stripped, so it
  -- never contains '_' and split_part cannot truncate it.
  v_prefix := split_part(p_key, '_', 2);
  v_secret := split_part(p_key, '_', 3);

  if v_prefix = '' or v_secret = ''
     -- A fourth segment means the key is malformed, not merely wrong.
     or split_part(p_key, '_', 4) <> ''
     or split_part(p_key, '_', 1) <> 'inferspool' then
    return null;
  end if;

  select * into v_row from public.api_keys
  where prefix = v_prefix and revoked_at is null;

  if v_row.id is null then
    -- Constant-ish work for an unknown prefix, so timing does not reveal which
    -- prefixes exist.
    perform extensions.crypt(v_secret, extensions.gen_salt('bf', 12));
    return null;
  end if;

  if v_row.secret_hash <> extensions.crypt(v_secret, v_row.secret_hash) then
    return null;
  end if;

  update public.api_keys set last_used_at = now() where id = v_row.id;
  return v_row.user_id;
end;
$$;

revoke all on function private.auth_api_key(text)
  from public, anon, authenticated;

-- Queue mechanics -------------------------------------------------------------

-- Exponential backoff, capped at 5 minutes. The exponent is clamped before
-- exponentiation: power(2, 44) overflows an interval and power(2, <negative>)
-- yields a zero delay, and either would let one malformed row break every
-- caller of reclaim_expired().
create or replace function private.backoff(p_attempts int)
returns interval
language sql
immutable
set search_path = ''
as $$
  select make_interval(secs =>
    least(power(2, least(greatest(coalesce(p_attempts, 0), 0), 20)), 300));
$$;

-- Reclaim leases whose worker went away (power cut, OOM, ISP drop). Called at
-- the top of claim_jobs so it runs exactly when it matters, with no cron.
create or replace function private.reclaim_expired()
returns void
language sql
security definer
set search_path = ''
as $$
  update public.jobs set
    -- A job canceled while running must end canceled, not go back in the
    -- queue: claim skips cancel_requested rows, so requeueing it would strand
    -- it in 'queued' forever.
    status       = case when cancel_requested then 'canceled'::public.job_status
                        when attempts >= max_attempts then 'failed'::public.job_status
                        else 'queued'::public.job_status end,
    error        = case when not cancel_requested and attempts >= max_attempts
                        then 'lease expired; retries exhausted' end,
    finished_at  = case when cancel_requested or attempts >= max_attempts
                        then now() end,
    can_start_at = now() + private.backoff(attempts),
    worker_id        = null,
    lease_expires_at = null
  where status = 'running' and lease_expires_at < now();
$$;

revoke all on function private.reclaim_expired() from public, anon, authenticated;

-- Atomically take up to p_limit jobs.
--
-- `p_types` is what the worker has just probed as healthy; it is intersected
-- with the worker's configured `capabilities`, so naming an unconfigured type
-- cannot widen a worker's permissions. Pass null to mean "everything I am
-- configured for".
--
-- FOR UPDATE SKIP LOCKED is what makes two workers unable to take the same
-- row. Each claimed job carries its own lease, so heartbeat_batch must renew
-- them together.
create or replace function claim_jobs(
  p_worker_id  text,
  p_token      text,
  p_types      text[] default null,
  p_limit      int default 8,
  p_lease_secs int default 60
)
returns setof jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caps text[];
  v_live text[];
begin
  perform private.auth_worker(p_worker_id, p_token);
  perform private.reclaim_expired();

  select capabilities into v_caps from public.workers where id = p_worker_id;

  if p_types is null then
    v_live := v_caps;
  else
    select array_agg(t) into v_live
    from unnest(p_types) t
    where t = any (v_caps);
  end if;

  if v_live is null or cardinality(v_live) = 0 then
    return;
  end if;

  return query
    update public.jobs set
      status           = 'running',
      worker_id        = p_worker_id,
      lease_expires_at = now() + make_interval(secs => p_lease_secs),
      attempts         = attempts + 1,
      started_at       = coalesce(started_at, now()),
      progress         = null,
      progress_msg     = null
    where id in (
      select id from public.jobs
      where status = 'queued'
        and type = any (v_live)
        and can_start_at <= now()
        and not cancel_requested
      order by priority desc, can_start_at
      for update skip locked
      limit least(greatest(coalesce(p_limit, 1), 1), 64)
    )
    returning *;
end;
$$;

-- Renew every lease in a batch and report which jobs the user canceled. There
-- is no way to reach into a worker's process from the cloud, so cancellation
-- has to be something the worker asks about and honours.
--
-- Renewing the whole batch together matters: with 8 jobs in flight, renewing
-- only the one currently decoding would let the other 7 expire.
create or replace function heartbeat_batch(
  p_worker_id  text,
  p_token      text,
  p_job_ids    uuid[],
  p_lease_secs int default 60
)
returns table (id uuid, cancel_requested boolean)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.auth_worker(p_worker_id, p_token);

  return query
    update public.jobs j set
      lease_expires_at = now() + make_interval(secs => p_lease_secs)
    where j.id = any (p_job_ids)
      and j.status = 'running'
      -- Fencing: silently skip jobs we no longer own. The caller treats an
      -- absent row as "lease lost".
      and j.worker_id = p_worker_id
    returning j.id, j.cancel_requested;
end;
$$;

-- Per-job progress, separate from heartbeat_batch so a slow progress write
-- cannot delay a lease renewal.
create or replace function progress_batch(
  p_worker_id text,
  p_token     text,
  p_updates   jsonb    -- [{"id": "…", "progress": 0.4, "msg": "…"}]
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  perform private.auth_worker(p_worker_id, p_token);

  with u as (
    select (e->>'id')::uuid       as id,
           (e->>'progress')::real as progress,
           e->>'msg'              as msg
    from jsonb_array_elements(coalesce(p_updates, '[]'::jsonb)) e
  )
  update public.jobs j set
    progress     = coalesce(u.progress, j.progress),
    progress_msg = coalesce(u.msg, j.progress_msg)
  from u
  where j.id = u.id and j.status = 'running' and j.worker_id = p_worker_id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function complete_job(
  p_worker_id text,
  p_token     text,
  p_job_id    uuid,
  p_result    jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.auth_worker(p_worker_id, p_token);

  update public.jobs set
    status = 'succeeded', result = p_result, progress = 1,
    finished_at = now(), lease_expires_at = null, error = null
  where id = p_job_id and status = 'running' and worker_id = p_worker_id;

  if not found then
    raise exception 'lease lost for job %', p_job_id using errcode = 'P0002';
  end if;
end;
$$;

-- p_retryable distinguishes "the GPU hiccuped, try again" from "this input
-- will never work" — the latter must not burn every attempt.
create or replace function fail_job(
  p_worker_id text,
  p_token     text,
  p_job_id    uuid,
  p_error     text,
  p_retryable boolean default true
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.auth_worker(p_worker_id, p_token);

  -- One guarded statement, not SELECT-then-UPDATE. Under READ COMMITTED a
  -- blocked UPDATE re-checks its WHERE against the new row version, so a guard
  -- of `id` alone would let a stalled worker requeue a job another worker had
  -- already claimed or even finished. Reading cancel_requested in the same
  -- statement also closes the race against a concurrent request_cancel().
  update public.jobs set
    status = case
               when cancel_requested then 'canceled'::public.job_status
               when p_retryable and attempts < max_attempts
                 then 'queued'::public.job_status
               else 'failed'::public.job_status
             end,
    error            = p_error,
    lease_expires_at = null,
    worker_id        = null,
    can_start_at     = now() + private.backoff(attempts),
    finished_at      = case
                         when cancel_requested or not p_retryable
                              or attempts >= max_attempts then now()
                       end
  where id = p_job_id and status = 'running' and worker_id = p_worker_id;

  if not found then
    raise exception 'lease lost for job %', p_job_id using errcode = 'P0002';
  end if;
end;
$$;

-- Service registry ------------------------------------------------------------

-- Workers publish probe results here. The whole set is replaced each call, so a
-- backend removed from the config disappears rather than lingering as stale.
create or replace function report_services(
  p_worker_id text,
  p_token     text,
  p_services  jsonb  -- [{"type","name","healthy","detail","models","capacity"}]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_types text[];
begin
  perform private.auth_worker(p_worker_id, p_token);

  select array_agg(e->>'type') into v_types
  from jsonb_array_elements(coalesce(p_services, '[]'::jsonb)) e
  where e->>'type' is not null;

  insert into public.worker_services
        (worker_id, type, name, healthy, detail, models, capacity, last_check)
  select p_worker_id,
         e->>'type',
         e->>'name',
         coalesce((e->>'healthy')::boolean, false),
         e->>'detail',
         coalesce(array(select jsonb_array_elements_text(e->'models')), '{}'),
         least(greatest(coalesce((e->>'capacity')::int, 1), 1), 256),
         now()
  from jsonb_array_elements(coalesce(p_services, '[]'::jsonb)) e
  where e->>'type' is not null
  on conflict (worker_id, type) do update set
    name       = excluded.name,
    healthy    = excluded.healthy,
    detail     = excluded.detail,
    models     = excluded.models,
    capacity   = excluded.capacity,
    last_check = now();

  delete from public.worker_services ws
  where ws.worker_id = p_worker_id
    and not (ws.type = any (coalesce(v_types, '{}')));
end;
$$;

-- Queue depth per type, so each backend is scheduled separately and a worker
-- can skip probing when there is nothing to do.
create or replace function pending_by_type(p_worker_id text, p_token text)
returns table (type text, n bigint)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_caps text[];
begin
  perform private.auth_worker(p_worker_id, p_token);
  select capabilities into v_caps from public.workers where id = p_worker_id;

  return query
    select j.type::text, count(*)
    from public.jobs j
    where j.status = 'queued' and j.type = any (v_caps)
      and j.can_start_at <= now() and not j.cancel_requested
    group by j.type;
end;
$$;

-- What the UI renders: per-type backend counts plus capacity, so it can say
-- "2 of 3 image backends up, 12 slots" rather than just "worker online".
--
-- A worker counts as online only if it heartbeated recently AND its service row
-- is fresh, so a hung worker is not advertised as available.
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
    'queued',  (select count(*) from public.jobs where status = 'queued'),
    'running', (select count(*) from public.jobs where status = 'running'),

    -- Workers with at least one healthy backend, i.e. able to do actual work.
    'workers_online', (
      select count(distinct worker_id) from live where healthy and fresh
    ),

    'services', (
      select coalesce(jsonb_object_agg(type, detail), '{}'::jsonb)
      from (
        select coalesce(l.type, q.type) as type,
               jsonb_build_object(
                 'up',       coalesce(sum(case when l.healthy and l.fresh
                                               then 1 else 0 end), 0),
                 'total',    count(l.worker_id),
                 'capacity', coalesce(sum(case when l.healthy and l.fresh
                                               then l.capacity else 0 end), 0),
                 'queued',   coalesce(max(q.n), 0)
               ) as detail
        from live l
        full outer join (
          select type::text as type, count(*) as n from public.jobs
          where status = 'queued' group by type
        ) q on q.type = l.type
        group by coalesce(l.type, q.type)
      ) s
    ),

    -- Identifying detail only for signed-in users.
    'workers', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', case when auth.uid() is not null then w.id end,
               'capabilities', case when auth.uid() is not null
                                    then to_jsonb(w.capabilities) end,
               'online', coalesce(w.last_heartbeat > now() - interval '90 seconds',
                                  false),
               'services', case when auth.uid() is not null then (
                 select coalesce(jsonb_agg(jsonb_build_object(
                          'type', s.type, 'name', s.name,
                          'healthy', s.healthy and s.fresh,
                          'detail', s.detail, 'models', to_jsonb(s.models),
                          'capacity', s.capacity)), '[]'::jsonb)
                 from live s where s.worker_id = w.id
               ) end
             )), '[]'::jsonb)
      from public.workers w
    )
  );
$$;

-- Client API ------------------------------------------------------------------

-- Issue an API key. Returns the plaintext exactly once; only the hash is kept.
create or replace function create_api_key(p_label text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_prefix text;
  v_secret text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if (select count(*) from public.api_keys
      where user_id = v_uid and revoked_at is null) >= 20 then
    raise exception 'too many active keys' using errcode = '54000';
  end if;

  -- base64 with '+/=' removed, so the key is safe in headers, URLs and shell
  -- copy-paste, and contains no '_' to confuse the prefix/secret split.
  -- Retry on the (astronomically unlikely) prefix collision.
  for attempt in 1..5 loop
    v_prefix := lower(translate(encode(extensions.gen_random_bytes(8),
                                       'base64'), '+/=', ''));
    exit when not exists (select 1 from public.api_keys where prefix = v_prefix);
    v_prefix := null;
  end loop;

  if v_prefix is null then
    raise exception 'could not allocate a key prefix' using errcode = '55000';
  end if;

  v_secret := translate(encode(extensions.gen_random_bytes(32), 'base64'),
                        '+/=', '');

  insert into public.api_keys (user_id, prefix, secret_hash, label)
  values (v_uid, v_prefix,
          extensions.crypt(v_secret, extensions.gen_salt('bf', 12)), p_label);

  return 'inferspool_' || v_prefix || '_' || v_secret;
end;
$$;

-- Submit with an API key. SECURITY DEFINER because the CLI authenticates with a
-- key rather than a JWT, so auth.uid() is null and the RLS INSERT policy cannot
-- apply. Ownership therefore comes from the key itself.
create or replace function submit_job(
  p_key             text,
  p_type            text,
  p_payload         jsonb,
  p_priority        int default 0,
  p_idempotency_key text default null
)
returns jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_job public.jobs;
begin
  v_uid := private.auth_api_key(p_key);
  if v_uid is null then
    raise exception 'invalid api key' using errcode = '28000';
  end if;

  insert into public.jobs (user_id, type, payload, priority, idempotency_key)
  values (v_uid, p_type::public.job_type, coalesce(p_payload, '{}'::jsonb),
          p_priority, p_idempotency_key)
  returning * into v_job;

  return v_job;
exception
  -- Resubmitting the same idempotency_key returns the original job instead of
  -- an error, so a retrying script is naturally safe.
  when unique_violation then
    select * into v_job from public.jobs
    where user_id = v_uid and idempotency_key = p_idempotency_key;
    return v_job;
end;
$$;

create or replace function list_jobs(
  p_key    text,
  p_limit  int default 20,
  p_status job_status default null
)
returns setof jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
begin
  v_uid := private.auth_api_key(p_key);
  if v_uid is null then
    raise exception 'invalid api key' using errcode = '28000';
  end if;

  return query
    select * from public.jobs
    where user_id = v_uid
      and (p_status is null or status = p_status)
    order by created_at desc
    limit least(greatest(coalesce(p_limit, 20), 1), 200);
end;
$$;

create or replace function get_job(p_key text, p_job_id uuid)
returns jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_job public.jobs;
begin
  v_uid := private.auth_api_key(p_key);
  if v_uid is null then
    raise exception 'invalid api key' using errcode = '28000';
  end if;

  select * into v_job from public.jobs
  where id = p_job_id and user_id = v_uid;

  return v_job;
end;
$$;

create or replace function cancel_job_by_key(p_key text, p_job_id uuid)
returns job_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid;
  v_status public.job_status;
begin
  v_uid := private.auth_api_key(p_key);
  if v_uid is null then
    raise exception 'invalid api key' using errcode = '28000';
  end if;

  update public.jobs set
    cancel_requested = true,
    status      = case when status = 'queued' then 'canceled'::public.job_status
                       else status end,
    finished_at = case when status = 'queued' then now() else finished_at end
  where id = p_job_id and user_id = v_uid and status in ('queued', 'running')
  returning status into v_status;

  return v_status;
end;
$$;

-- Cancellation for the web UI (session auth). SECURITY DEFINER because there is
-- deliberately no UPDATE policy on jobs: as SECURITY INVOKER this would be
-- filtered to zero rows by RLS and silently cancel nothing.
create or replace function request_cancel(p_job_id uuid)
returns job_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.job_status;
begin
  update public.jobs set
    cancel_requested = true,
    status      = case when status = 'queued' then 'canceled'::public.job_status
                       else status end,
    finished_at = case when status = 'queued' then now() else finished_at end
  where id = p_job_id
    and user_id = auth.uid()
    and status in ('queued', 'running')
  returning status into v_status;

  return v_status;
end;
$$;

-- Realtime --------------------------------------------------------------------

-- Any write fires this, including plain SQL from a worker, so the browser gets
-- push updates without the worker knowing Realtime exists.
create or replace function private.broadcast_job()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Two topics: per job for a detail view, per user so a list view can use a
  -- single channel. Realtime matches channel names exactly, so a list view
  -- cannot subscribe to per-job topics.
  perform realtime.broadcast_changes(
    'job:' || new.id::text, tg_op, tg_op,
    tg_table_name, tg_table_schema, new, old
  );
  perform realtime.broadcast_changes(
    'user:' || new.user_id::text, tg_op, tg_op,
    tg_table_name, tg_table_schema, new, old
  );
  return null;
end;
$$;

create trigger jobs_broadcast
  after insert or update on jobs
  for each row execute function private.broadcast_job();

-- Scope Realtime reads to the owner. Without a policy, Realtime Authorization
-- denies everything by default. Parsing the uuid out of the topic keeps this
-- index-friendly; comparing against 'job:' || id::text would seq-scan.
create policy "own job broadcasts" on realtime.messages
  for select to authenticated
  using (
    extension = 'broadcast'
    and (
      realtime.topic() = 'user:' || auth.uid()::text
      or exists (
        select 1 from public.jobs
        where realtime.topic() like 'job:%'
          and id = substring(realtime.topic() from 5)::uuid
          and user_id = auth.uid()
      )
    )
  );

-- Private channels also write a join record, so INSERT must be permitted.
create policy "own job broadcast writes" on realtime.messages
  for insert to authenticated
  with check (
    extension = 'broadcast'
    and (
      realtime.topic() = 'user:' || auth.uid()::text
      or exists (
        select 1 from public.jobs
        where realtime.topic() like 'job:%'
          and id = substring(realtime.topic() from 5)::uuid
          and user_id = auth.uid()
      )
    )
  );

-- Grants ----------------------------------------------------------------------
-- Worker and CLI RPCs are reachable with the public anon key but useless
-- without a valid worker token or API key, which each verifies first.

revoke all on function claim_jobs(text, text, text[], int, int) from public;
revoke all on function heartbeat_batch(text, text, uuid[], int) from public;
revoke all on function progress_batch(text, text, jsonb) from public;
revoke all on function complete_job(text, text, uuid, jsonb) from public;
revoke all on function fail_job(text, text, uuid, text, boolean) from public;
revoke all on function report_services(text, text, jsonb) from public;
revoke all on function pending_by_type(text, text) from public;
revoke all on function queue_stats() from public;
revoke all on function create_api_key(text) from public;
revoke all on function submit_job(text, text, jsonb, int, text) from public;
revoke all on function list_jobs(text, int, job_status) from public;
revoke all on function get_job(text, uuid) from public;
revoke all on function cancel_job_by_key(text, uuid) from public;
revoke all on function request_cancel(uuid) from public;

grant execute on function claim_jobs(text, text, text[], int, int) to anon;
grant execute on function heartbeat_batch(text, text, uuid[], int) to anon;
grant execute on function progress_batch(text, text, jsonb) to anon;
grant execute on function complete_job(text, text, uuid, jsonb) to anon;
grant execute on function fail_job(text, text, uuid, text, boolean) to anon;
grant execute on function report_services(text, text, jsonb) to anon;
grant execute on function pending_by_type(text, text) to anon;
grant execute on function queue_stats() to anon, authenticated;
grant execute on function submit_job(text, text, jsonb, int, text)
  to anon, authenticated;
grant execute on function list_jobs(text, int, job_status) to anon, authenticated;
grant execute on function get_job(text, uuid) to anon, authenticated;
grant execute on function cancel_job_by_key(text, uuid) to anon, authenticated;

-- Key issuance and web cancellation need a real session.
grant execute on function create_api_key(text) to authenticated;
grant execute on function request_cancel(uuid) to authenticated;
