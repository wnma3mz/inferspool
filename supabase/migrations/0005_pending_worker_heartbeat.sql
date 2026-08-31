-- pending_by_type authenticates the worker, and auth_worker refreshes its
-- heartbeat. Mark it volatile so hosted PostgREST does not run it in a
-- read-only transaction.
alter function public.pending_by_type(text, text) volatile;
