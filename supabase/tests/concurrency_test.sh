#!/usr/bin/env bash
# Verifies FOR UPDATE SKIP LOCKED really prevents double-claiming, by racing
# many real connections against a queue. A single-threaded SQL test cannot
# prove this.
set -euo pipefail

DB="${1:-inferspool_test}"
JOBS=40
CLIENTS=8

. "$(dirname "$0")/lib.sh"
inferspool_setup_pg || exit 1

psql -q -d "$DB" <<SQL
truncate jobs cascade;
delete from workers;
delete from auth.users;
insert into auth.users (id) values ('11111111-1111-1111-1111-111111111111');
insert into workers (id, token_hash)
select 'w' || g, extensions.crypt('t', extensions.gen_salt('bf'))
from generate_series(1, $CLIENTS) g;
insert into worker_services(worker_id,type,healthy,last_check)
select 'w' || g, 'image', true, now() from generate_series(1, $CLIENTS) g;
insert into jobs (user_id, type, payload)
select '11111111-1111-1111-1111-111111111111', 'image', '{}'
from generate_series(1, $JOBS);
SQL

# Each client hammers claim_job until the queue drains, recording what it got.
for i in $(seq 1 $CLIENTS); do
  (
    for _ in $(seq 1 $((JOBS * 2))); do
      psql -q -At -d "$DB" \
        -c "select id from claim_jobs('w$i', 't', null, 1, 300)" 2>/dev/null
    done
  ) > "/tmp/inferspool_claims_$i.txt" &
done
wait

cat /tmp/inferspool_claims_*.txt | grep -v '^$' | sort > /tmp/inferspool_all_claims.txt
total=$(wc -l < /tmp/inferspool_all_claims.txt | tr -d ' ')
uniq_n=$(sort -u /tmp/inferspool_all_claims.txt | wc -l | tr -d ' ')
running=$(psql -q -At -d "$DB" -c "select count(*) from jobs where status='running'")

echo "claims=$total unique=$uniq_n running=$running expected=$JOBS"

fail=0
[ "$total" -eq "$uniq_n" ] || { echo "FAIL: a job was claimed twice"; fail=1; }
[ "$total" -eq "$JOBS" ]   || { echo "FAIL: claimed $total of $JOBS jobs"; fail=1; }
[ "$running" -eq "$JOBS" ] || { echo "FAIL: $running running, expected $JOBS"; fail=1; }

rm -f /tmp/inferspool_claims_*.txt /tmp/inferspool_all_claims.txt
[ "$fail" -eq 0 ] && echo "Concurrency test passed: no double-claims across $CLIENTS clients."
exit $fail
