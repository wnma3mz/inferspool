-- Admin membership is managed only by trusted deployment tooling using the
-- service-role key. Browser sessions have no table privileges or RLS policy.
grant select, insert, delete on table public.admins to service_role;
