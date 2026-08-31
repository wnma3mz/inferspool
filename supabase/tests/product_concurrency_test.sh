#!/usr/bin/env bash
# Race product-level invariants across real PostgreSQL connections. Sequential
# SQL tests cannot prove advisory-lock and SKIP LOCKED behaviour.
set -euo pipefail

DB="${1:-inferspool_test}"
. "$(dirname "$0")/lib.sh"
inferspool_setup_pg || exit 1

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
alice=11111111-1111-1111-1111-111111111111
bob=22222222-2222-2222-2222-222222222222

psql -q -v ON_ERROR_STOP=1 -d "$DB" <<SQL
truncate jobs cascade;
delete from webhooks;
delete from api_keys;
delete from user_profiles;
delete from auth.users;
insert into auth.users(id) values ('$alice'),('$bob');
insert into user_profiles(user_id,max_active_jobs,daily_job_limit)
values ('$alice',1,100),('$bob',100,100);
SQL

# Ten submissions all see the same one-slot quota. The per-user advisory lock
# must serialize their count+insert sections so exactly one succeeds.
for i in $(seq 1 10); do
  (psql -q -At -v ON_ERROR_STOP=1 -d "$DB" \
    -c "insert into jobs(user_id,type,payload) values('$alice','llm','{\"prompt\":\"$i\"}') returning id" \
    >"$tmp/quota-$i" 2>/dev/null || true) &
done
wait
quota_rows=$(psql -q -At -d "$DB" -c "select count(*) from jobs where user_id='$alice' and status='queued'")
[ "$quota_rows" -eq 1 ] || { echo "FAIL: concurrent quota admitted $quota_rows jobs"; exit 1; }
echo "ok   concurrent submissions cannot exceed the active-job quota"

# Concurrent retries of one failed source must create one active child. The
# partial unique index is the final guard even if both callers pass the lookup.
source_id=$(psql -q -At -d "$DB" -c "insert into jobs(user_id,type,payload) values('$bob','llm','{\"prompt\":\"retry\"}') returning id")
psql -q -d "$DB" -c "update jobs set status='failed',finished_at=now() where id='$source_id'" >/dev/null
for i in $(seq 1 10); do
  (psql -q -At -v ON_ERROR_STOP=1 -d "$DB" \
    -c "select set_config('request.jwt.claim.sub','$bob',false); select id from retry_job('$source_id')" \
    >"$tmp/retry-$i" 2>/dev/null || true) &
done
wait
retry_rows=$(psql -q -At -d "$DB" -c "select count(*) from jobs where source_job_id='$source_id' and status in ('queued','running')")
[ "$retry_rows" -eq 1 ] || { echo "FAIL: concurrent retry created $retry_rows active children"; exit 1; }
echo "ok   concurrent retries create exactly one active child"

# Build 40 due deliveries and race eight claimers. Every id must be returned
# exactly once; delivering rows receive a five-minute recovery lease.
psql -q -v ON_ERROR_STOP=1 -d "$DB" <<SQL
truncate jobs cascade;
delete from webhooks;
insert into webhooks(id,user_id,url,secret_hash,secret_ciphertext)
values('aaaaaaaa-0000-0000-0000-000000000000','$bob','https://example.com/jobs','hash','cipher');
insert into jobs(user_id,type,payload)
select '$bob','llm',jsonb_build_object('prompt',g) from generate_series(1,40) g;
update jobs set status='failed',finished_at=now() where user_id='$bob';
SQL
for i in $(seq 1 8); do
  (for _ in $(seq 1 10); do
    psql -q -At -d "$DB" -c "select id from claim_webhook_deliveries(1)" 2>/dev/null
  done) >"$tmp/delivery-$i" &
done
wait
cat "$tmp"/delivery-* | grep -v '^$' | sort >"$tmp/deliveries"
delivery_total=$(wc -l <"$tmp/deliveries" | tr -d ' ')
delivery_unique=$(sort -u "$tmp/deliveries" | wc -l | tr -d ' ')
delivery_leased=$(psql -q -At -d "$DB" -c "select count(*) from webhook_deliveries where status='delivering' and next_attempt_at>now()+interval '4 minutes'")
[ "$delivery_total" -eq 40 ] && [ "$delivery_unique" -eq 40 ] && [ "$delivery_leased" -eq 40 ] || {
  echo "FAIL: webhook claims total=$delivery_total unique=$delivery_unique leased=$delivery_leased"; exit 1;
}
echo "ok   concurrent webhook claims are unique and recoverable"

# Only one concurrent caller may claim a named maintenance interval.
psql -q -d "$DB" -c "delete from maintenance_runs where name='race-test'" >/dev/null
for i in $(seq 1 10); do
  psql -q -At -d "$DB" -c "select claim_maintenance('race-test',60)" >"$tmp/maintenance-$i" &
done
wait
maintenance_true=$(cat "$tmp"/maintenance-* | grep -c '^t$' || true)
[ "$maintenance_true" -eq 1 ] || { echo "FAIL: maintenance claimed by $maintenance_true callers"; exit 1; }
echo "ok   maintenance throttle has one concurrent winner"

echo "Product concurrency tests passed."
