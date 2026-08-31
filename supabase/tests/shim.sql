-- Local-only stand-ins for what Supabase provides, so 0001_init.sql can be
-- executed and tested against a plain Postgres. Never applied to Supabase.

create schema if not exists extensions;
create schema if not exists auth;
create schema if not exists realtime;
create schema if not exists storage;

create extension if not exists pgcrypto with schema extensions;

create table if not exists auth.users (
  id uuid primary key,
  email text,
  created_at timestamptz not null default now(),
  last_sign_in_at timestamptz,
  banned_until timestamptz
);

-- Supabase derives auth.uid() from the request JWT; locally we fake it with a
-- session GUC that tests can set.
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create table if not exists realtime.messages (
  id        bigserial primary key,
  topic     text,
  event     text,
  extension text,
  payload   jsonb
);

-- Minimal Storage catalog used only to compile and exercise RLS policies.
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null,
  name text not null,
  owner_id text
);
create or replace function storage.foldername(name text) returns text[]
language sql immutable as $$
  select (string_to_array(name, '/'))[
    1:greatest(coalesce(array_length(string_to_array(name, '/'), 1), 1) - 1, 0)
  ];
$$;

create or replace function realtime.topic() returns text
language sql stable as $$ select current_setting('realtime.topic', true); $$;

create or replace function realtime.broadcast_changes(
  topic_name text, event_name text, operation text,
  table_name text, table_schema text, new_record anyelement, old_record anyelement
) returns void language sql as $$
  insert into realtime.messages (topic, event, extension, payload)
  values (topic_name, event_name, 'broadcast',
          jsonb_build_object('op', operation, 'record', to_jsonb(new_record)));
$$;

do $$ begin
  create role anon nologin;
exception when duplicate_object then null; end $$;

do $$ begin
  create role authenticated nologin;
exception when duplicate_object then null; end $$;

do $$ begin
  create role service_role nologin;
exception when duplicate_object then null; end $$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;
