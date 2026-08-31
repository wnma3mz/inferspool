-- Embeddings are no longer a supported product task. Keep completed rows as
-- history, but stop active work and reject every new embed value. NOT VALID
-- lets existing historical values remain readable while enforcing the
-- constraint for all future inserts and updates.

update jobs set
  status = 'canceled',
  cancel_requested = true,
  worker_id = null,
  lease_expires_at = null,
  finished_at = now(),
  error = 'Embedding tasks are no longer supported'
where type::text = 'embed'
  and status in ('queued', 'running');

delete from worker_services where type = 'embed';
update workers
set capabilities = array_remove(capabilities, 'embed')
where capabilities @> array['embed'];

alter domain job_type drop constraint if exists job_type_check;
alter domain job_type add constraint job_type_check
  check (value in ('image', 'video', 'tts', 'llm')) not valid;
