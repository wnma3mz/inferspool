-- 0008 was already deployed before its direct PostgREST table access was
-- exercised against the hosted role grants. Apply the complete table contract
-- to existing projects; fresh projects also receive it from 0008.

grant select, insert, update, delete on table jobs to service_role;
grant select, update on table api_keys to service_role;
grant select on table worker_services to service_role;
grant select on table job_events to service_role;
