-- Parameter validation embeds workers through worker_services so disabled
-- backends are excluded. PostgREST requires SELECT on both sides of that join.
grant select on table workers to service_role;
