-- Product foundation: invited accounts, compute pools, worker administration,
-- immutable retry lineage, result retention, webhooks, quotas and observability.
-- Existing users and workers are placed in the default shared pool.

create type account_status as enum ('invited', 'active', 'disabled');
create type compute_pool_kind as enum ('shared', 'personal', 'team');
create type webhook_event as enum ('job.succeeded', 'job.failed', 'job.canceled');
create type delivery_status as enum ('pending', 'delivering', 'succeeded', 'failed');

create table user_profiles (
  user_id                uuid primary key references auth.users(id) on delete cascade,
  status                 account_status not null default 'active',
  force_password_change  boolean not null default false,
  max_active_jobs        int not null default 100 check (max_active_jobs between 1 and 1000),
  daily_job_limit        int not null default 500 check (daily_job_limit between 1 and 100000),
  max_priority           int not null default 5 check (max_priority between 0 and 10),
  retention_days         int not null default 30 check (retention_days between 1 and 3650),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

insert into user_profiles (user_id)
select id from auth.users on conflict (user_id) do nothing;

create table compute_pools (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name        text not null check (length(name) between 1 and 100),
  kind        compute_pool_kind not null default 'shared',
  created_by  uuid references auth.users(id) on delete set null,
  disabled_at timestamptz,
  created_at  timestamptz not null default now()
);

insert into compute_pools (id, slug, name, kind)
values ('00000000-0000-0000-0000-000000000001', 'shared', 'Shared GPU pool', 'shared')
on conflict (id) do nothing;

create table compute_pool_members (
  pool_id    uuid not null references compute_pools(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'member' check (role in ('owner', 'operator', 'member')),
  created_at timestamptz not null default now(),
  primary key (pool_id, user_id)
);

alter table workers
  add column display_name text,
  add column pool_id uuid references compute_pools(id) on delete restrict
    default '00000000-0000-0000-0000-000000000001',
  add column disabled_at timestamptz,
  add column token_rotated_at timestamptz not null default now();
update workers set display_name = coalesce(display_name, id),
                   pool_id = coalesce(pool_id, '00000000-0000-0000-0000-000000000001');
alter table workers alter column pool_id set not null;

alter table jobs
  add column source_job_id uuid references jobs(id) on delete set null,
  add column pool_id uuid references compute_pools(id) on delete restrict
    default '00000000-0000-0000-0000-000000000001',
  add column keep_result boolean not null default false,
  add column retained_until timestamptz,
  add column deletion_requested_at timestamptz,
  add column deleted_at timestamptz,
  add column tags text[] not null default '{}';
update jobs set pool_id = coalesce(pool_id, '00000000-0000-0000-0000-000000000001'),
                retained_until = coalesce(retained_until, created_at + interval '30 days');
alter table jobs alter column pool_id set not null;
create index jobs_source_idx on jobs(source_job_id) where source_job_id is not null;
create unique index jobs_one_active_retry_idx on jobs(source_job_id)
  where source_job_id is not null and status in ('queued','running') and deleted_at is null;
create index jobs_retention_idx on jobs(retained_until)
  where deleted_at is null and not keep_result and status in ('succeeded','failed','canceled');
create index jobs_search_idx on jobs using gin (to_tsvector('simple', coalesce(payload->>'prompt', payload->>'text', '')));
create index jobs_tags_idx on jobs using gin(tags);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('inputs', 'inputs', false, 20971520,
        array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do update set public=false,
  file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

create policy "owners upload inputs" on storage.objects
  for insert to authenticated with check (
    bucket_id='inputs' and (storage.foldername(name))[1]=auth.uid()::text
  );
create policy "owners read inputs" on storage.objects
  for select to authenticated using (
    bucket_id='inputs' and (storage.foldername(name))[1]=auth.uid()::text
  );
create policy "owners delete inputs" on storage.objects
  for delete to authenticated using (
    bucket_id='inputs' and (storage.foldername(name))[1]=auth.uid()::text
  );

create table job_events (
  id         bigserial primary key,
  job_id     uuid not null references jobs(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  event      webhook_event not null,
  payload    jsonb not null,
  created_at timestamptz not null default now(),
  unique(job_id, event)
);

create table webhooks (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  url                  text not null check (url ~ '^https://'),
  secret_hash          text not null,
  secret_ciphertext    text not null,
  events               webhook_event[] not null default array['job.succeeded','job.failed','job.canceled']::webhook_event[],
  description          text,
  consecutive_failures int not null default 0,
  disabled_at          timestamptz,
  created_at           timestamptz not null default now()
);
create index webhooks_user_idx on webhooks(user_id, created_at desc);

create table webhook_deliveries (
  id             uuid primary key default gen_random_uuid(),
  webhook_id     uuid not null references webhooks(id) on delete cascade,
  event_id       bigint not null references job_events(id) on delete cascade,
  status         delivery_status not null default 'pending',
  attempts       int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_status    int,
  last_error     text,
  delivered_at  timestamptz,
  created_at     timestamptz not null default now(),
  unique(webhook_id, event_id)
);
create index webhook_delivery_due_idx on webhook_deliveries(next_attempt_at)
  where status in ('pending','failed','delivering');

create or replace function record_webhook_failure(p_webhook_id uuid)
returns int language plpgsql security definer set search_path='' as $$
declare failures int;
begin
  update public.webhooks set consecutive_failures=consecutive_failures+1
  where id=p_webhook_id returning consecutive_failures into failures;
  return failures;
end;
$$;

create table worker_events (
  id         bigserial primary key,
  worker_id  text not null references workers(id) on delete cascade,
  event      text not null check (event in ('created','online','offline','token_rotated','disabled','enabled','revoked','service_failed')),
  detail     jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index worker_events_worker_idx on worker_events(worker_id, created_at desc);

create table maintenance_runs (
  name text primary key,
  last_started_at timestamptz not null default '-infinity'
);

create or replace function claim_maintenance(p_name text,p_interval_seconds int)
returns boolean language plpgsql security definer set search_path='' as $$
declare claimed boolean:=false;
begin
  insert into public.maintenance_runs(name) values(p_name) on conflict do nothing;
  update public.maintenance_runs set last_started_at=now()
  where name=p_name and last_started_at<=now()-make_interval(secs=>greatest(p_interval_seconds,1));
  claimed:=found; return claimed;
end;
$$;

create or replace function claim_webhook_deliveries(p_limit int default 50)
returns setof webhook_deliveries language plpgsql security definer set search_path='' as $$
begin
  return query with picked as (
    select d.id from public.webhook_deliveries d join public.webhooks w on w.id=d.webhook_id
    where d.status in ('pending','failed','delivering') and d.next_attempt_at<=now() and w.disabled_at is null
    order by d.next_attempt_at for update of d skip locked limit least(greatest(coalesce(p_limit,50),1),200)
  )
  update public.webhook_deliveries d set status='delivering',next_attempt_at=now()+interval '5 minutes'
  from picked where d.id=picked.id returning d.*;
end;
$$;

alter table worker_services
  add column parameter_schema jsonb not null default '{}'::jsonb;

-- Workers advertise model-independent product parameters and their accepted
-- ranges. The stable API uses this before enqueueing so unsupported options do
-- not wait for a GPU only to fail there.
create or replace function report_services(
  p_worker_id text,
  p_token text,
  p_services jsonb
)
returns void language plpgsql security definer set search_path='' as $$
declare v_types text[];
begin
  perform private.auth_worker(p_worker_id,p_token);
  select array_agg(e->>'type') into v_types
  from jsonb_array_elements(coalesce(p_services,'[]'::jsonb)) e
  where e->>'type' is not null;
  insert into public.worker_events(worker_id,event,detail)
  select p_worker_id,'service_failed',jsonb_build_object('type',e->>'type','detail',e->>'detail')
  from jsonb_array_elements(coalesce(p_services,'[]'::jsonb)) e
  left join public.worker_services old on old.worker_id=p_worker_id and old.type=e->>'type'
  where coalesce((e->>'healthy')::boolean,false)=false and coalesce(old.healthy,true)=true;
  insert into public.worker_services
    (worker_id,type,name,healthy,detail,models,capacity,last_check,parameter_schema)
  select p_worker_id,e->>'type',e->>'name',coalesce((e->>'healthy')::boolean,false),e->>'detail',
    coalesce(array(select jsonb_array_elements_text(e->'models')),'{}'),
    least(greatest(coalesce((e->>'capacity')::int,1),1),256),now(),
    case when jsonb_typeof(e->'parameter_schema')='object' then e->'parameter_schema' else '{}'::jsonb end
  from jsonb_array_elements(coalesce(p_services,'[]'::jsonb)) e
  where e->>'type' is not null
  on conflict(worker_id,type) do update set
    name=excluded.name,healthy=excluded.healthy,detail=excluded.detail,models=excluded.models,
    capacity=excluded.capacity,last_check=now(),parameter_schema=excluded.parameter_schema;
  delete from public.worker_services ws
  where ws.worker_id=p_worker_id and not (ws.type=any(coalesce(v_types,'{}')));
end;
$$;

alter table user_profiles enable row level security;
alter table compute_pools enable row level security;
alter table compute_pool_members enable row level security;
alter table job_events enable row level security;
alter table webhooks enable row level security;
alter table webhook_deliveries enable row level security;
alter table worker_events enable row level security;

create policy "own profile readable" on user_profiles for select to authenticated using (user_id = auth.uid());
create policy "visible pools readable" on compute_pools for select to authenticated using (
  kind = 'shared' or exists(select 1 from compute_pool_members m where m.pool_id = id and m.user_id = auth.uid())
);
create policy "own pool memberships readable" on compute_pool_members for select to authenticated using (user_id = auth.uid());
create policy "own events readable" on job_events for select to authenticated using (user_id = auth.uid());
create policy "own webhooks readable" on webhooks for select to authenticated using (user_id = auth.uid());

create or replace function private.ensure_profile(p_user_id uuid)
returns public.user_profiles
language plpgsql security definer set search_path = '' as $$
declare v_profile public.user_profiles;
begin
  insert into public.user_profiles(user_id) values(p_user_id) on conflict do nothing;
  select * into v_profile from public.user_profiles where user_id = p_user_id;
  return v_profile;
end;
$$;

create or replace function private.validate_job_payload(p_type text, p_payload jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare v jsonb := coalesce(p_payload, '{}'::jsonb); n numeric;
begin
  if p_type not in ('llm','image','video','tts') then
    raise exception 'unsupported job type' using errcode='22023';
  end if;
  if p_type = 'llm' then
    if v ? 'temperature' and ((v->>'temperature')::numeric < 0 or (v->>'temperature')::numeric > 2) then raise exception 'temperature must be between 0 and 2' using errcode='22023'; end if;
    if v ? 'max_tokens' and ((v->>'max_tokens')::int < 1 or (v->>'max_tokens')::int > 131072) then raise exception 'max_tokens is out of range' using errcode='22023'; end if;
  elsif p_type = 'image' then
    if v ? 'num_inference_steps' and ((v->>'num_inference_steps')::int < 1 or (v->>'num_inference_steps')::int > 200) then raise exception 'num_inference_steps is out of range' using errcode='22023'; end if;
    if v ? 'size' and (v->>'size') !~ '^[0-9]{2,5}x[0-9]{2,5}$' then raise exception 'size must look like 1024x1024' using errcode='22023'; end if;
  elsif p_type = 'video' then
    if v ? 'num_inference_steps' and ((v->>'num_inference_steps')::int < 1 or (v->>'num_inference_steps')::int > 200) then raise exception 'num_inference_steps is out of range' using errcode='22023'; end if;
    if v ? 'size' and (v->>'size') !~ '^[0-9]{2,5}x[0-9]{2,5}$' then raise exception 'size must look like 1280x720' using errcode='22023'; end if;
    if v ? 'seconds' and ((v->>'seconds')::numeric <= 0 or (v->>'seconds')::numeric > 300) then raise exception 'seconds is out of range' using errcode='22023'; end if;
    if v ? 'fps' and ((v->>'fps')::int < 1 or (v->>'fps')::int > 240) then raise exception 'fps is out of range' using errcode='22023'; end if;
  elsif p_type = 'tts' then
    if v ? 'speed' and ((v->>'speed')::numeric < 0.25 or (v->>'speed')::numeric > 4) then raise exception 'speed is out of range' using errcode='22023'; end if;
    if v ? 'response_format' and v->>'response_format' not in ('wav','mp3','flac','pcm','opus') then raise exception 'unsupported audio response_format' using errcode='22023'; end if;
  end if;
exception when invalid_text_representation then
  raise exception 'job parameter has the wrong type' using errcode='22023';
end;
$$;

create or replace function private.prepare_product_job()
returns trigger language plpgsql security definer set search_path = '' as $$
declare p public.user_profiles; active_count int; today_count int;
begin
  -- Serialize submissions per user so concurrent requests cannot both observe
  -- a free quota slot and exceed the configured limit.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text, 1701));
  p := private.ensure_profile(new.user_id);
  if p.status = 'disabled' then raise exception 'account disabled' using errcode='42501'; end if;
  select count(*) into active_count from public.jobs where user_id=new.user_id and status in ('queued','running') and deleted_at is null;
  if active_count >= p.max_active_jobs then raise exception 'active job quota exceeded' using errcode='54000'; end if;
  select count(*) into today_count from public.jobs where user_id=new.user_id and created_at >= date_trunc('day', now());
  if today_count >= p.daily_job_limit then raise exception 'daily job quota exceeded' using errcode='54000'; end if;
  perform private.validate_job_payload(new.type::text, new.payload);
  new.priority := least(coalesce(new.priority,0), case when private.is_admin(new.user_id) then 10 else p.max_priority end);
  new.retained_until := coalesce(new.retained_until, now() + make_interval(days => p.retention_days));
  new.pool_id := coalesce(new.pool_id, '00000000-0000-0000-0000-000000000001');
  return new;
end;
$$;
create trigger jobs_product_prepare before insert on jobs for each row execute function private.prepare_product_job();

-- Retention starts when a result becomes terminal, not while it is waiting for
-- a sleeping GPU.
create or replace function private.set_terminal_retention()
returns trigger language plpgsql security definer set search_path='' as $$
declare days int;
begin
  if new.status in ('succeeded','failed','canceled') and old.status not in ('succeeded','failed','canceled') then
    select retention_days into days from public.user_profiles where user_id=new.user_id;
    new.retained_until:=now()+make_interval(days=>coalesce(days,30));
  end if;
  return new;
end;
$$;
create trigger jobs_terminal_retention before update of status on jobs
for each row execute function private.set_terminal_retention();

drop policy "own jobs readable" on jobs;
create policy "own jobs readable" on jobs for select to authenticated using (user_id=auth.uid() and deleted_at is null);

create or replace function private.emit_terminal_event()
returns trigger language plpgsql security definer set search_path = '' as $$
declare e public.webhook_event; event_id bigint;
begin
  if new.status not in ('succeeded','failed','canceled') or (old.status = new.status) then return null; end if;
  e := ('job.' || new.status::text)::public.webhook_event;
  insert into public.job_events(job_id,user_id,event,payload)
    values(new.id,new.user_id,e,jsonb_build_object('id',new.id,'type',new.type,'status',new.status,'result',new.result,'error',new.error,'finished_at',new.finished_at))
    on conflict(job_id,event) do nothing returning id into event_id;
  if event_id is not null then
    insert into public.webhook_deliveries(webhook_id,event_id)
      select w.id,event_id from public.webhooks w where w.user_id=new.user_id and w.disabled_at is null and e=any(w.events)
      on conflict do nothing;
  end if;
  return null;
end;
$$;
create trigger jobs_terminal_event after update of status on jobs for each row execute function private.emit_terminal_event();

create or replace function retry_job(p_job_id uuid)
returns jobs language plpgsql security definer set search_path = '' as $$
declare old_job public.jobs; new_job public.jobs;
begin
  select * into old_job from public.jobs where id=p_job_id and user_id=auth.uid() and status in ('failed','canceled') and deleted_at is null;
  if old_job.id is null then return null; end if;
  if exists(select 1 from public.jobs where source_job_id=old_job.id and status in ('queued','running')) then return null; end if;
  insert into public.jobs(user_id,type,payload,priority,source_job_id,pool_id,tags)
    values(old_job.user_id,old_job.type,old_job.payload,old_job.priority,old_job.id,old_job.pool_id,old_job.tags)
    returning * into new_job;
  return new_job;
exception when unique_violation then return null;
end;
$$;

create or replace function retry_job_by_key(p_key text,p_job_id uuid)
returns jobs language plpgsql security definer set search_path = '' as $$
declare uid uuid; old_job public.jobs; new_job public.jobs;
begin
  uid:=private.auth_api_key(p_key); if uid is null then raise exception 'invalid api key' using errcode='28000'; end if;
  select * into old_job from public.jobs where id=p_job_id and user_id=uid and status in ('failed','canceled') and deleted_at is null;
  if old_job.id is null then return null; end if;
  if exists(select 1 from public.jobs where source_job_id=old_job.id and status in ('queued','running')) then return null; end if;
  insert into public.jobs(user_id,type,payload,priority,source_job_id,pool_id,tags)
    values(uid,old_job.type,old_job.payload,old_job.priority,old_job.id,old_job.pool_id,old_job.tags) returning * into new_job;
  return new_job;
exception when unique_violation then return null;
end;
$$;

create or replace function request_job_deletion(p_job_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.jobs set deletion_requested_at=now() where id=p_job_id and user_id=auth.uid() and status in ('succeeded','failed','canceled') and deleted_at is null;
  return found;
end;
$$;

create or replace function request_job_deletion_by_key(p_key text,p_job_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare uid uuid;
begin
  uid:=private.auth_api_key(p_key); if uid is null then raise exception 'invalid api key' using errcode='28000'; end if;
  update public.jobs set deletion_requested_at=now() where id=p_job_id and user_id=uid and status in ('succeeded','failed','canceled') and deleted_at is null;
  return found;
end;
$$;

create or replace function set_job_retention(p_job_id uuid,p_keep boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.jobs set keep_result=coalesce(p_keep,false) where id=p_job_id and user_id=auth.uid() and deleted_at is null;
  return found;
end;
$$;

-- A worker may request a short-lived URL only for an input explicitly attached
-- to a job whose current lease it owns.
create or replace function worker_input_target(
  p_worker_id text,p_token text,p_job_id uuid,p_bucket text,p_path text
)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  perform private.auth_worker(p_worker_id,p_token);
  return p_bucket='inputs' and exists(
    select 1 from public.jobs j
    where j.id=p_job_id and j.status='running' and j.worker_id=p_worker_id
      and j.lease_expires_at>now()
      and p_path like j.user_id::text||'/%'
      and exists(
        select 1 from jsonb_array_elements(coalesce(j.payload->'images','[]'::jsonb)) image
        where image->>'bucket'=p_bucket and image->>'path'=p_path
      )
  );
end;
$$;

create or replace function client_input_owner(p_key text)
returns table(user_id uuid) language plpgsql security definer set search_path='' as $$
declare uid uuid;
begin
  uid:=private.auth_api_key(p_key);
  if uid is null then raise exception 'invalid api key' using errcode='28000'; end if;
  return query select uid;
end;
$$;

-- Worker administration. Plain tokens are returned once and only bcrypt hashes persist.
create or replace function private.new_worker_token()
returns text language sql volatile set search_path='' as $$ select translate(encode(extensions.gen_random_bytes(32),'base64'),'+/=',''); $$;

create or replace function admin_create_worker(p_id text,p_name text,p_types text[],p_pool_id uuid default '00000000-0000-0000-0000-000000000001')
returns jsonb language plpgsql security definer set search_path='' as $$
declare token text;
begin
  if not private.is_admin(auth.uid()) then raise exception 'administrator access required' using errcode='42501'; end if;
  if p_id !~ '^[a-z0-9][a-z0-9_-]{2,62}$' then raise exception 'invalid worker id' using errcode='22023'; end if;
  if coalesce(cardinality(p_types),0)=0 or exists(select 1 from unnest(p_types) t where t not in ('llm','image','video','tts')) then raise exception 'invalid worker capabilities' using errcode='22023'; end if;
  token:=private.new_worker_token();
  insert into public.workers(id,display_name,capabilities,pool_id,token_hash)
    values(p_id,coalesce(nullif(trim(p_name),''),p_id),p_types,p_pool_id,extensions.crypt(token,extensions.gen_salt('bf',12)));
  insert into public.worker_events(worker_id,event) values(p_id,'created');
  return jsonb_build_object('id',p_id,'token',token,'types',p_types,'env','INFERSPOOL_WORKER_ID='||p_id||E'\nINFERSPOOL_WORKER_TOKEN='||token||E'\n');
end;
$$;

create or replace function admin_rotate_worker_token(p_worker_id text)
returns text language plpgsql security definer set search_path='' as $$
declare token text;
begin
  if not private.is_admin(auth.uid()) then raise exception 'administrator access required' using errcode='42501'; end if;
  token:=private.new_worker_token();
  update public.workers set token_hash=extensions.crypt(token,extensions.gen_salt('bf',12)),token_rotated_at=now() where id=p_worker_id;
  if not found then return null; end if;
  insert into public.worker_events(worker_id,event) values(p_worker_id,'token_rotated'); return token;
end;
$$;

create or replace function admin_set_worker_disabled(p_worker_id text,p_disabled boolean)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if not private.is_admin(auth.uid()) then raise exception 'administrator access required' using errcode='42501'; end if;
  update public.workers set disabled_at=case when p_disabled then now() end where id=p_worker_id;
  if found then insert into public.worker_events(worker_id,event) values(p_worker_id,case when p_disabled then 'disabled' else 'enabled' end); end if;
  return found;
end;
$$;

create or replace function admin_revoke_worker(p_worker_id text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if not private.is_admin(auth.uid()) then raise exception 'administrator access required' using errcode='42501'; end if;
  update public.workers set
    token_hash=extensions.crypt(private.new_worker_token(),extensions.gen_salt('bf',12)),
    token_rotated_at=now(),disabled_at=now()
  where id=p_worker_id;
  if found then insert into public.worker_events(worker_id,event) values(p_worker_id,'revoked'); end if;
  return found;
end;
$$;

create or replace function admin_list_workers()
returns jsonb language plpgsql security definer set search_path='' stable as $$
declare result jsonb;
begin
  if not private.is_admin(auth.uid()) then
    raise exception 'administrator access required' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',w.id,'name',w.display_name,'pool_id',w.pool_id,'capabilities',w.capabilities,'disabled_at',w.disabled_at,
    'last_heartbeat',w.last_heartbeat,'created_at',w.created_at,'services',(select coalesce(jsonb_agg(to_jsonb(s)),'[]') from public.worker_services s where s.worker_id=w.id)
  ) order by w.created_at desc),'[]') into result from public.workers w;
  return result;
end;
$$;

-- Replace worker authentication so disabled workers are rejected immediately.
create or replace function private.auth_worker(p_worker_id text,p_token text)
returns void language plpgsql security definer set search_path='' as $$
declare h text; disabled timestamptz; previous_heartbeat timestamptz;
begin
  select token_hash,disabled_at,last_heartbeat into h,disabled,previous_heartbeat from public.workers where id=p_worker_id for update;
  if h is null then perform extensions.crypt(coalesce(p_token,''),extensions.gen_salt('bf',12)); raise exception 'bad worker credentials' using errcode='28000'; end if;
  if disabled is not null or p_token is null or h<>extensions.crypt(p_token,h) then raise exception 'bad worker credentials' using errcode='28000'; end if;
  update public.workers set last_heartbeat=now() where id=p_worker_id;
  if previous_heartbeat is null or previous_heartbeat<=now()-interval '90 seconds' then
    insert into public.worker_events(worker_id,event) values(p_worker_id,'online');
  end if;
end;
$$;

create or replace function record_offline_workers()
returns int language plpgsql security definer set search_path='' as $$
declare count_inserted int;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('inferspool-record-offline-workers',0));
  with stale as (
    select w.id from public.workers w
    where w.disabled_at is null and w.last_heartbeat<=now()-interval '90 seconds'
      and coalesce((select e.event from public.worker_events e where e.worker_id=w.id and e.event in ('online','offline') order by e.created_at desc,e.id desc limit 1),'online')='online'
    for update of w skip locked
  )
  insert into public.worker_events(worker_id,event) select id,'offline' from stale;
  get diagnostics count_inserted=row_count;
  return count_inserted;
end;
$$;

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
      (case when jsonb_typeof(j.result->'files')='array' then j.result->'files' else '[]'::jsonb end) ||
      (case when jsonb_typeof(j.result->'file')='object' then jsonb_build_array(j.result->'file') else '[]'::jsonb end)
    ) f where j.deleted_at is null),
    'by_type',(select coalesce(jsonb_object_agg(type,stats),'{}') from (select type::text type,jsonb_build_object('total',count(*),'succeeded',count(*) filter(where status='succeeded'),'failed',count(*) filter(where status='failed'),'canceled',count(*) filter(where status='canceled'),'success_rate',round(100.0*count(*) filter(where status='succeeded')/nullif(count(*) filter(where status in ('succeeded','failed')),0),1),'avg_queue_seconds',round(avg(extract(epoch from started_at-created_at)) filter(where started_at is not null),1),'avg_run_seconds',round(avg(extract(epoch from finished_at-started_at)) filter(where finished_at is not null and started_at is not null),1)) stats from public.jobs where created_at>=since and deleted_at is null group by type)s)
  ) into out; return out;
end;
$$;

-- Fairer claim: take users' first waiting job before their second, while still
-- respecting priority inside each user's queue and worker pool routing.
create or replace function claim_jobs(p_worker_id text,p_token text,p_types text[] default null,p_limit int default 8,p_lease_secs int default 60)
returns setof jobs language plpgsql security definer set search_path='' as $$
declare caps text[]; live text[]; worker_pool uuid;
begin
  perform private.auth_worker(p_worker_id,p_token); perform private.reclaim_expired();
  select capabilities,pool_id into caps,worker_pool from public.workers where id=p_worker_id;
  if p_types is null then live:=caps; else select array_agg(t) into live from unnest(p_types)t where t=any(caps); end if;
  if live is null or cardinality(live)=0 then return; end if;
  return query with ranked as (
    select j.id,row_number() over(partition by j.user_id order by j.priority desc,j.can_start_at,j.created_at) rn
    from public.jobs j where j.status='queued' and j.type=any(live) and j.pool_id=worker_pool and j.deleted_at is null and j.can_start_at<=now() and not j.cancel_requested
  ), picked as (select j.id from public.jobs j join ranked r on r.id=j.id order by r.rn,j.priority desc,j.can_start_at for update of j skip locked limit least(greatest(coalesce(p_limit,1),1),64))
  update public.jobs j set status='running',worker_id=p_worker_id,lease_expires_at=now()+make_interval(secs=>p_lease_secs),attempts=j.attempts+1,started_at=coalesce(j.started_at,now()),progress=null,progress_msg=null
  from picked where j.id=picked.id and j.status='queued' and not j.cancel_requested returning j.*;
end;
$$;

-- Admin retry now preserves the old immutable history.
create or replace function admin_retry_job(p_job_id uuid)
returns jobs language plpgsql security definer set search_path='' as $$
declare old_job public.jobs; new_job public.jobs;
begin
  if not private.is_admin(auth.uid()) then raise exception 'administrator access required' using errcode='42501'; end if;
  select * into old_job from public.jobs where id=p_job_id and status in ('failed','canceled') and deleted_at is null;
  if old_job.id is null then return null; end if;
  if exists(select 1 from public.jobs where source_job_id=old_job.id and status in ('queued','running')) then return null; end if;
  insert into public.jobs(user_id,type,payload,priority,source_job_id,pool_id,tags) values(old_job.user_id,old_job.type,old_job.payload,old_job.priority,old_job.id,old_job.pool_id,old_job.tags) returning * into new_job;
  return new_job;
exception when unique_violation then return null;
end;
$$;

revoke all on function retry_job(uuid),retry_job_by_key(text,uuid),request_job_deletion(uuid),request_job_deletion_by_key(text,uuid),set_job_retention(uuid,boolean) from public;
revoke all on function worker_input_target(text,text,uuid,text,text),client_input_owner(text) from public;
revoke all on function admin_create_worker(text,text,text[],uuid),admin_rotate_worker_token(text),admin_set_worker_disabled(text,boolean),admin_revoke_worker(text),admin_list_workers(),admin_metrics(int) from public;
revoke all on function record_webhook_failure(uuid) from public;
revoke all on function claim_maintenance(text,int),claim_webhook_deliveries(int) from public;
revoke all on function record_offline_workers() from public;
grant execute on function retry_job(uuid),request_job_deletion(uuid),set_job_retention(uuid,boolean) to authenticated;
grant execute on function retry_job_by_key(text,uuid),request_job_deletion_by_key(text,uuid) to anon,authenticated;
grant execute on function worker_input_target(text,text,uuid,text,text),client_input_owner(text) to anon,service_role;
grant execute on function admin_create_worker(text,text,text[],uuid),admin_rotate_worker_token(text),admin_set_worker_disabled(text,boolean),admin_revoke_worker(text),admin_list_workers(),admin_metrics(int) to authenticated;
grant execute on function record_webhook_failure(uuid) to service_role;
grant execute on function claim_maintenance(text,int),claim_webhook_deliveries(int) to service_role;
grant execute on function record_offline_workers() to service_role;
grant select on user_profiles,compute_pools,compute_pool_members,job_events,webhooks to authenticated;
grant select,insert,update,delete on user_profiles,compute_pools,compute_pool_members,webhooks,webhook_deliveries,worker_events,maintenance_runs to service_role;
