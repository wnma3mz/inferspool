# InferSpool architecture

This document records the invariants behind the implementation. The user-facing
entry points are the [project README](../README.md) and [runbook](RUNBOOK.md).

## Components and trust boundaries

```text
CLI ───────────────┐
                   ├─ product /v1 API ─ Postgres / Storage
GPU Worker ────────┘                         │
                                            ├─ Realtime ─ Web
Web ─ Supabase Auth ─────────────────────────┘
```

- The CLI authenticates with an InferSpool API key.
- The GPU Worker authenticates with a Worker ID and token.
- The Web app uses a Supabase Auth session; registration remains disabled.
- Edge Functions hold service-role access. User and Worker machines never receive
  database credentials.
- GPU inference endpoints listen locally. The Worker makes outbound requests to
  the cloud and local requests to vLLM / vLLM-Omni.

The `/v1` API is the product boundary for CLI and Worker clients. Supabase Auth,
REST, Storage and RPC paths remain implementation details. The browser keeps
direct Auth and Realtime integration because those are session and delivery
mechanisms rather than the public automation API.

## Job lifecycle

`jobs` is the only source of truth for queue state and user-visible history:

```text
queued ──claim──> running ──complete──> succeeded
   ▲                 │  │
   │                 │  ├─cancel──> canceled
   └────retry────────┘  └─attempts exhausted──> failed
```

User retry creates a new row with `source_job_id`; it does not overwrite the
failed job. Deleting a job also deletes its private input and result objects.
Retention cleanup skips rows explicitly marked to keep.

### Claim gate

The Worker checks in this order:

1. Is there compatible queued work?
2. Is the corresponding local backend healthy, or can it be started?
3. Claim only work the backend can run.

Queued work is the reason to start an on-demand backend. Probing first would
observe an intentionally stopped service and never start it. Claiming before a
backend is ready would waste an attempt while a model is still loading.

Claims use one atomic statement with `FOR UPDATE SKIP LOCKED`, ordered by
priority and eligibility time. Concurrent Workers therefore cannot receive the
same job.

### Leases and recovery

A claim grants a finite lease. A batch heartbeat renews every active job while
handlers execute. If the Worker disappears, the next claim operation recovers
expired rows with exponential backoff. Jobs reaching `max_attempts` become
`failed`, so a permanently broken task cannot consume GPU capacity forever.

Recovery runs inside the claim path, not in a separate scheduler. It executes at
the moment another Worker needs the recovered work and adds no cron dependency.

Every Worker mutation is a single statement guarded by both job status and
Worker ownership. This prevents a process that resumes after its lease expired
from overwriting the new owner. PostgreSQL rechecks an `UPDATE` predicate against
the current row version after lock contention; a separate read and write would
not preserve the same guarantee.

### Cancellation and progress

Cancellation is cooperative because the cloud cannot signal a process behind
NAT. Heartbeats return `cancel_requested`. LLM handlers check between streaming
chunks; synchronous multimedia handlers cancel their HTTP context. Progress and
messages travel Worker → Postgres → Realtime/Web, with polling as a fallback.

Token-by-token output streaming is not implemented. Adding it requires a durable
chunk representation and delivery contract; the existing progress fields are
status updates, not a token transport.

## Backend registry and process supervision

Each configured job type has an independent `ServiceSpec`, health state,
capacity and advertised parameter schema. One unhealthy backend blocks only its
own task type.

vLLM performs continuous batching, so LLM capacity may be greater than one.
Image and video capacity defaults to one unless the local Omni deployment is
explicitly prepared for concurrent generations.

On-demand supervision is opt-in through `INFERSPOOL_<TYPE>_LAUNCH`. A frontend
shell process is placed in its own process group so shutdown also reaches child
processes spawned by vLLM. External supervisors such as systemd or Docker require
an explicit `STOP` command.

Exclusive-GPU mode is the default for managed services. It stops another managed
backend before loading a new model, trading model-switch latency for predictable
single-card memory use.

## Data access and security

- Users cannot update `jobs` directly. Cancel, retry, keep and delete operations
  are guarded server-side.
- Insert triggers reset queue-owned columns and clamp priority/attempt values,
  preventing forged history or arbitrary queue priority.
- API keys are displayed once, stored as hashes and can only move toward revoked.
- Worker tokens use bcrypt cost 12 and are displayed only at creation or rotation.
- `workers` and `worker_services` have RLS enabled without client read policies;
  public availability is exposed only through reduced queue statistics.
- Worker health expires after 90 seconds, so a stalled process is not counted as
  online.
- Result objects are private. Job records contain object path, MIME type and size;
  authorized clients receive short-lived download URLs.

Realtime is a fast path, not the source of truth. Job mutations broadcast to a
job-specific topic and a user-list topic. The Web app also polls every four
seconds while visible jobs are nonterminal, so a dropped WebSocket cannot leave
the interface permanently stale.

## Scheduling and indexes

Per-user active and daily limits are enforced transactionally. User-supplied
priority is capped by the account profile. Queue indexes are partial indexes on
queued/running rows, keeping them small as history grows.

Retry backoff clamps the exponent before computing the interval. This prevents a
corrupt or extreme attempt count from overflowing an interval inside the claim
path and blocking all Workers.

## Webhooks and maintenance

Account webhooks emit terminal job events. Endpoint secrets are encrypted at
rest, payloads are signed, deliveries retry, and repeatedly failing endpoints can
be disabled. Cleanup and webhook dispatch use maintenance secrets and database
locks so concurrent invocations do not process the same work twice.

## Compatibility surface

`supabase/functions/sign-*-upload` and `sign-*-download` are retained for older
clients and integration fixtures. Current CLI and Worker builds use the product
API. Do not add new behavior to the legacy signer endpoints; remove them only in
a planned compatibility release after old clients are no longer supported.

The Web type layer also accepts legacy `embed` rows so old history remains
renderable. New `embed` submissions are rejected and no current UI exposes that
job type.
