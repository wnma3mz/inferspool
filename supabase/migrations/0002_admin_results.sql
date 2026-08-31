-- Product completion: private result storage and deliberately narrow admin APIs.

create table admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table admins enable row level security;
-- No table policy: membership is only managed from SQL/service-role contexts.

create or replace function private.is_admin(p_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select p_user_id is not null and exists (
    select 1 from public.admins where user_id = p_user_id
  );
$$;

revoke all on function private.is_admin(uuid) from public, anon, authenticated;

create or replace function is_admin()
returns boolean
language sql
security definer
stable
set search_path = ''
as $$ select private.is_admin(auth.uid()); $$;

create or replace function admin_list_jobs(
  p_limit int default 100,
  p_status job_status default null,
  p_type job_type default null,
  p_user_id uuid default null
)
returns setof jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin(auth.uid()) then
    raise exception 'administrator access required' using errcode = '42501';
  end if;
  return query
    select j.* from public.jobs j
    where (p_status is null or j.status = p_status)
      and (p_type is null or j.type = p_type)
      and (p_user_id is null or j.user_id = p_user_id)
    order by j.created_at desc
    limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;

create or replace function admin_cancel_job(p_job_id uuid)
returns job_status
language plpgsql
security definer
set search_path = ''
as $$
declare v_status public.job_status;
begin
  if not private.is_admin(auth.uid()) then
    raise exception 'administrator access required' using errcode = '42501';
  end if;
  update public.jobs set
    cancel_requested = true,
    status = case when status = 'queued' then 'canceled'::public.job_status
                  else status end,
    finished_at = case when status = 'queued' then now() else finished_at end
  where id = p_job_id and status in ('queued', 'running')
  returning status into v_status;
  return v_status;
end;
$$;

create or replace function admin_retry_job(p_job_id uuid)
returns jobs
language plpgsql
security definer
set search_path = ''
as $$
declare v_job public.jobs;
begin
  if not private.is_admin(auth.uid()) then
    raise exception 'administrator access required' using errcode = '42501';
  end if;
  update public.jobs set
    status = 'queued', attempts = 0, result = null, error = null,
    progress = null, progress_msg = null, worker_id = null,
    lease_expires_at = null, cancel_requested = false,
    can_start_at = now(), started_at = null, finished_at = null
  where id = p_job_id and status in ('succeeded', 'failed', 'canceled')
  returning * into v_job;
  return v_job;
end;
$$;

-- Called by the upload-signing Edge Function. Credentials are verified here,
-- and a worker may upload only while it owns the live lease for this job.
create or replace function worker_upload_target(
  p_worker_id text, p_token text, p_job_id uuid
)
returns table(user_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.auth_worker(p_worker_id, p_token);
  return query select j.user_id from public.jobs j
    where j.id = p_job_id and j.status = 'running'
      and j.worker_id = p_worker_id and j.lease_expires_at > now();
end;
$$;

create or replace function client_download_target(
  p_key text, p_job_id uuid, p_bucket text, p_path text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_uid uuid;
begin
  v_uid := private.auth_api_key(p_key);
  if v_uid is null then
    raise exception 'invalid api key' using errcode = '28000';
  end if;
  return p_bucket = 'results'
    and p_path like v_uid::text || '/' || p_job_id::text || '/%'
    and exists (select 1 from public.jobs
                where id = p_job_id and user_id = v_uid);
end;
$$;

insert into storage.buckets (id, name, public, file_size_limit)
values ('results', 'results', false, 1073741824)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

create policy "owners and admins read results" on storage.objects
  for select to authenticated using (
    bucket_id = 'results' and (
      (storage.foldername(name))[1] = auth.uid()::text
      or private.is_admin(auth.uid())
    )
  );

revoke all on function is_admin() from public;
revoke all on function admin_list_jobs(int, job_status, job_type, uuid) from public;
revoke all on function admin_cancel_job(uuid) from public;
revoke all on function admin_retry_job(uuid) from public;
revoke all on function worker_upload_target(text, text, uuid) from public;
revoke all on function client_download_target(text, uuid, text, text) from public;

grant execute on function is_admin() to authenticated;
grant execute on function admin_list_jobs(int, job_status, job_type, uuid) to authenticated;
grant execute on function admin_cancel_job(uuid) to authenticated;
grant execute on function admin_retry_job(uuid) to authenticated;
grant execute on function worker_upload_target(text, text, uuid) to anon, service_role;
grant execute on function client_download_target(text, uuid, text, text) to anon, service_role;
