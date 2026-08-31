-- RLS decides which rows a signed-in browser may access, but Postgres table
-- privileges still have to allow the operation before RLS is evaluated.
grant select, insert on table public.jobs to authenticated;
grant select, update on table public.api_keys to authenticated;
