# Contributing

Back to the [project README](../README.md).

## Repository layout

```text
cmd/inferspool/         shipped user CLI
cmd/inferspool-worker/  shipped GPU Worker and Python integration fixtures
supabase/migrations/    schema, RLS and RPCs
supabase/functions/     product API and background Edge Functions
supabase/tests/         SQL and concurrency suites
web/                    Next.js user and administrator UI
scripts/                release installers and installer tests
packaging/              package-manager templates
```

Generated output stays out of source control: Go binaries and `dist/`, Python
virtual environments and caches, Next.js `.next/` and `out/`, browser test
artifacts, local `.env` files, and TypeScript build metadata.

## Environment

Python fixtures use the uv environment at the repository root:

```bash
uv sync --frozen
```

The full suite additionally requires PostgreSQL, Go and pnpm.

```bash
# macOS
brew install postgresql@16 go pnpm
pg_ctl -D /opt/homebrew/var/postgresql@16 start

# Debian/Ubuntu
sudo apt install postgresql golang
npm install --global pnpm
```

`test.sh` finds `psql` on `PATH` and checks common Homebrew, Postgres.app and
Debian paths. Set `INFERSPOOL_PSQL=/path/to/psql` for another installation or
`INFERSPOOL_TEST_DB` to change the temporary database name.

## Validation

Run all checks before handing off a change:

```bash
./test.sh
```

Useful targeted checks:

```bash
(cd cmd/inferspool && go test -race ./...)
(cd cmd/inferspool-worker && go test -race ./...)
deno check supabase/functions/*/index.ts
(cd web && pnpm run typecheck && pnpm run build)
(cd web && pnpm run test:e2e)
```

The database suites use real Postgres connections, and Worker E2E uses real
HTTP servers. Browser E2E uses a local product API and Phoenix WebSocket fixture;
it never touches production data and does not require a GPU.

## Design conventions

### One source of truth

`jobs` holds both queue state and user-visible history. Do not add a second
store for job progress or terminal state.

### Guard every Worker write

Worker RPCs must be single statements guarded by
`status = 'running' and worker_id = <caller>`. A `SELECT` followed by an
`UPDATE` is not equivalent under `READ COMMITTED`: a stalled Worker could
otherwise overwrite the Worker that took over an expired lease.

### Test RLS as a real role

Most SQL suites run as the table owner and therefore bypass RLS. Policy changes
belong in `supabase/tests/security_test.sql`, which uses `SET ROLE authenticated`
and forces row-level security.

### Distinguish permanent and transient failures

Return `PermanentError` when an input can never succeed, such as a missing
required field or a backend 400/422 response. Other failures consume retry
attempts and use exponential backoff.

### Keep handlers cooperative

Call `batch.Check(job.ID, fraction, message)` at interruptible points to publish
progress and react to cancellation. A separate batch goroutine renews leases
while a backend request is blocked.

### Treat deployed migrations as immutable

Do not rewrite a migration already applied to an environment. Add a new,
forward-only migration and test both the resulting schema and its RLS grants.

### Keep the product API boundary

New CLI and Worker behavior goes through `/v1`; do not add new direct dependencies
on Supabase Auth, REST, Storage or RPC endpoints. The browser may use Supabase
Auth sessions and Realtime channels.

## Adding a backend

1. Register a `ServiceSpec` in `cmd/inferspool-worker/services.go`.
2. Add its handler in `cmd/inferspool-worker/handlers.go` and register it in
   `newHandlers()`.
3. Add the type to the database `job_type` domain and its RPC validation.
4. Add the type to `JobType` in `web/lib/types.ts` and expose the intended UI.
5. Add Worker unit/E2E, SQL and browser coverage as applicable.

Backends are described by configuration rather than subclasses. Keep model
selection on the GPU side; the product API should expose generic task
parameters, not concrete model names.

## Before opening a PR

- `./test.sh` passes.
- New behavior has a test that fails without the change.
- No credentials, local `.env` files, generated output or absolute machine paths
  are included.
- Documentation and examples use the current `cmd/`, `supabase/` and `web/`
  layout.
