-- The stable /v1 Edge Function calls token-authenticated RPCs with its
-- service-role client. The RPCs still validate the API key or worker token;
-- this grant only lets the product API reach those checks.

grant execute on function queue_stats() to service_role;
grant execute on function submit_job(text, text, jsonb, int, text) to service_role;
grant execute on function cancel_job_by_key(text, uuid) to service_role;
grant execute on function retry_job_by_key(text, uuid) to service_role;

grant execute on function claim_jobs(text, text, text[], int, int) to service_role;
grant execute on function heartbeat_batch(text, text, uuid[], int) to service_role;
grant execute on function progress_batch(text, text, jsonb) to service_role;
grant execute on function complete_job(text, text, uuid, jsonb) to service_role;
grant execute on function fail_job(text, text, uuid, text, boolean) to service_role;
grant execute on function report_services(text, text, jsonb) to service_role;
grant execute on function pending_by_type(text, text) to service_role;
