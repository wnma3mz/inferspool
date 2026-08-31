#!/usr/bin/env bash
# End-to-end test of the compiled Go binary against the real SQL RPCs, via the
# same PostgREST shim the Python tests use. Verifies the shipped artifact, not
# just the packages.
set -uo pipefail

cd "$(dirname "$0")/../../.."
. supabase/tests/lib.sh
inferspool_setup_pg || exit 1

DB="${INFERSPOOL_TEST_DB:-inferspool_test}"
ALICE=11111111-1111-1111-1111-111111111111
BOB=22222222-2222-2222-2222-222222222222
BIN=/tmp/inferspool-e2e
fails=0

check() {  # check <condition-result> <label>
  if [ "$1" = "0" ]; then
    echo "ok   $2"
  else
    echo "FAIL $2"
    fails=$((fails + 1))
  fi
}

sql() { psql -q -At -d "$DB" -c "$1"; }

echo "building binary…"
(cd cmd/inferspool && go build -ldflags "-X main.version=e2e" -o "$BIN" .) || exit 1

# Start the PostgREST shim on a fixed port.
python3 - <<'PY' &
import sys, time
sys.path.insert(0, "cmd/inferspool-worker/tests")
from fake_postgrest import serve
srv, url = serve(54399)
while True:
    time.sleep(1)
PY
SHIM=$!
trap 'kill $SHIM 2>/dev/null' EXIT
sleep 2

sql "truncate jobs cascade; delete from api_keys; delete from worker_services;
     delete from workers; delete from auth.users;" > /dev/null
sql "insert into auth.users (id) values ('$ALICE'), ('$BOB')" > /dev/null

ALICE_KEY=$(sql "select set_config('request.jwt.claim.sub','$ALICE',false);
                 select create_api_key('go-cli')" | tail -1)
BOB_KEY=$(sql "select set_config('request.jwt.claim.sub','$BOB',false);
               select create_api_key('bob')" | tail -1)

CFG=$(mktemp -d)
export INFERSPOOL_CONFIG_DIR="$CFG"
export INFERSPOOL_URL="http://127.0.0.1:54399"
export INFERSPOOL_GATEWAY_KEY=anon
export NO_COLOR=1

"$BIN" config set-key "$ALICE_KEY" > /dev/null

# 1. config
out=$("$BIN" config advanced show)
[[ "$out" != *"$ALICE_KEY"* ]]; check $? "config show never prints the full key"
if stat -f '%Lp' "$CFG/config.json" >/dev/null 2>&1; then
  perms=$(stat -f '%Lp' "$CFG/config.json")
else
  perms=$(stat -c '%a' "$CFG/config.json")
fi
[ "$perms" = "600" ]; check $? "config file is chmod 600 (perms=$perms)"

# 2. submit
ID=$("$BIN" submit llm "hello from go")
[ ${#ID} -eq 36 ]; check $? "submit prints a job id"
[ "$(sql "select user_id from jobs where id='$ID'")" = "$ALICE" ]
check $? "job is owned by the key's user"
[ "$(sql "select payload->>'prompt' from jobs where id='$ID'")" = "hello from go" ]
check $? "prompt lands in the payload"

# tts uses `text`, not `prompt`
TTS=$("$BIN" submit tts "read this")
[ "$(sql "select payload->>'text' from jobs where id='$TTS'")" = "read this" ]
check $? "tts payload uses the text field"

# flags can appear in any order; jobs select only a task type, not a model
M=$("$BIN" submit llm --priority 3 "with flags")
[ "$(sql "select payload ? 'model' from jobs where id='$M'")" = "f" ]
check $? "submit payload does not select a model"
[ "$(sql "select priority from jobs where id='$M'")" = "3" ]
check $? "--priority is applied"

# --payload merges extra fields
P=$("$BIN" submit llm "custom" --payload '{"max_tokens":64}')
[ "$(sql "select payload->>'max_tokens' from jobs where id='$P'")" = "64" ]
check $? "--payload merges extra fields"

# Local images are uploaded privately and attached by object reference.
python3 - "$CFG/input.png" <<'PY'
import struct,sys,zlib
def chunk(k,d): return struct.pack('>I',len(d))+k+d+struct.pack('>I',zlib.crc32(k+d)&0xffffffff)
raw=b'\0'+bytes((20,90,180))*2
open(sys.argv[1],'wb').write(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',2,1,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b''))
PY
V=$("$BIN" submit llm "describe it" --image "$CFG/input.png")
[ "$(sql "select payload->'images'->0->>'bucket' from jobs where id='$V'")" = "inputs" ]
check $? "--image uploads a local image to private input storage"
[ "$(sql "select payload->'images'->0 ? 'url' from jobs where id='$V'")" = "f" ]
check $? "local image payload stores no public URL"
R=$("$BIN" submit llm "remote image" --image https://example.com/image.png)
[ "$(sql "select payload->'images'->0->>'url' from jobs where id='$R'")" = "https://example.com/image.png" ]
check $? "--image accepts an HTTPS image URL"

# stdin
S=$(echo "piped in" | "$BIN" submit llm --stdin)
[ "$(sql "select payload->>'prompt' from jobs where id='$S'")" = "piped in" ]
check $? "--stdin reads the prompt"

# 3. idempotency
A=$("$BIN" submit llm "once" --key dedupe-go)
B=$("$BIN" submit llm "twice" --key dedupe-go)
[ "$A" = "$B" ]; check $? "a repeated --key returns the original job"
[ "$(sql "select count(*) from jobs where idempotency_key='dedupe-go'")" = "1" ]
check $? "no duplicate row is created"

# 4. list
n=$("$BIN" list -n 50 | wc -l | tr -d ' ')
db=$(sql "select count(*) from jobs where user_id='$ALICE'")
[ "$n" = "$db" ]; check $? "list shows every one of the user's jobs (cli=$n db=$db)"
"$BIN" list --json | python3 -c 'import json,sys; json.load(sys.stdin)'
check $? "list --json emits valid JSON"

# --status filtering. Only the queue knows the difference, so assert against it.
sql "update jobs set status='succeeded' where id='$M'" > /dev/null
q_all=$("$BIN" list -n 100 --json | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')
q_queued=$("$BIN" list -n 100 --status queued --json | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')
q_done=$("$BIN" list -n 100 --status succeeded --json | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')
[ "$q_done" = "1" ]; check $? "list --status succeeded filters (got $q_done)"
[ "$q_queued" = "$((q_all - 1))" ]
check $? "list --status queued excludes the finished one ($q_queued of $q_all)"
sql "update jobs set status='queued' where id='$M'" > /dev/null

# 5. batch, and its determinism
printf 'line one\nline two\n\nline three\n' > "$CFG/prompts.txt"
before=$(sql "select count(*) from jobs")
ids=$("$BIN" batch llm "$CFG/prompts.txt")
[ "$(echo "$ids" | wc -l | tr -d ' ')" = "3" ]
check $? "batch submits one job per non-empty line"
after=$(sql "select count(*) from jobs")
[ "$after" = "$((before + 3))" ]; check $? "batch created exactly three jobs"

"$BIN" batch llm "$CFG/prompts.txt" > /dev/null
[ "$(sql "select count(*) from jobs")" = "$after" ]
check $? "re-running the same batch file is idempotent"

"$BIN" batch llm "$CFG/prompts.txt" --tag run2 > /dev/null
[ "$(sql "select count(*) from jobs")" = "$((after + 3))" ]
check $? "--tag resubmits as a new batch"

# batch from stdin
printf 'from stdin\n' | "$BIN" batch llm - > /dev/null
check $? "batch reads from stdin"

# 6. get and cancel
"$BIN" get "$ID" --json | python3 -c 'import json,sys; json.load(sys.stdin)'
check $? "get --json emits valid JSON"
"$BIN" get "$ID" --json > /dev/null
check $? "get on a queued job exits 0 (a query that worked)"
"$BIN" cancel "$ID" > /dev/null
[ "$(sql "select status from jobs where id='$ID'")" = "canceled" ]
check $? "cancel is persisted"

# Private result paths become short-lived URLs for the API-key owner.
RESULT_PATH="$ALICE/$TTS/audio.wav"
sql "update jobs set status='succeeded',
     result=jsonb_build_object('file', jsonb_build_object(
       'bucket','results','path','$RESULT_PATH','filename','audio.wav',
       'mime','audio/wav','bytes',42)) where id='$TTS'" > /dev/null
out=$("$BIN" get "$TTS")
[[ "$out" == https://download.test/*audio.wav ]];
check $? "get prints a signed URL for a private result"

# 7. cross-user isolation
"$BIN" config set-key "$BOB_KEY" > /dev/null
[ "$("$BIN" list --json)" = "[]" ]
check $? "another user's key sees no jobs (and marshals as [], not null)"
out=$("$BIN" get "$TTS" --json 2>/dev/null || true)
[ -z "$out" ] || [ "$(echo "$out" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("id",""))
except Exception: print("")')" = "" ]
check $? "another user cannot read someone else's job"

"$BIN" cancel "$TTS" > /dev/null 2>&1
[ $? -ne 0 ]; check $? "another user cannot cancel someone else's job"
[ "$(sql "select status from jobs where id='$TTS'")" != "canceled" ]
check $? "the job is untouched by the other user"

# 8. revoked key
sql "update api_keys set revoked_at = now() where prefix = '$(echo "$BOB_KEY" | cut -d_ -f2)'" > /dev/null
"$BIN" list > /dev/null 2>&1
[ $? -ne 0 ]; check $? "a revoked key is rejected"

"$BIN" config set-key inferspool_bogus_nope > /dev/null
"$BIN" list > /dev/null 2>&1
[ $? -ne 0 ]; check $? "an invalid key is rejected"

# 9. status: service counts
"$BIN" config set-key "$ALICE_KEY" > /dev/null
sql "insert into workers (id, capabilities, token_hash) values
     ('gpu1','{llm,image}', extensions.crypt('t', extensions.gen_salt('bf')));
     update workers set last_heartbeat = now();
     insert into worker_services (worker_id,type,name,healthy,capacity,last_check)
     values ('gpu1','llm','vllm',true,8,now()),
            ('gpu1','image','vllm-omni',false,1,now());" > /dev/null

out=$("$BIN" status)
[[ "$out" == *"1 worker(s) online"* ]]; check $? "status reports online workers"
[[ "$out" == *"llm"* && "$out" == *"1/1"* ]]; check $? "status shows a healthy backend"
[[ "$out" == *"image"* && "$out" == *"0/1"* ]]; check $? "status shows a down backend"

"$BIN" status --json | python3 -c '
import json,sys
d = json.load(sys.stdin)
assert d["services"]["llm"]["up"] == 1, d
assert d["services"]["llm"]["capacity"] == 8, d
assert d["services"]["image"]["up"] == 0, d
'
check $? "status --json reports per-type counts and capacity"

# Queued work with no healthy backend must exit non-zero, so scripts can detect
# "my GPU box is down".
sql "insert into jobs (user_id,type,payload) values ('$ALICE','image','{}'::jsonb)" > /dev/null
"$BIN" status > /dev/null 2>&1
[ $? -ne 0 ]; check $? "status exits non-zero when work cannot run"

# 10. timeout
Q=$("$BIN" submit llm "never runs")
start=$(date +%s)
"$BIN" watch "$Q" --timeout 3 -q > /dev/null 2>&1
rc=$?
elapsed=$(( $(date +%s) - start ))
[ $rc -ne 0 ]; check $? "watch --timeout exits non-zero"
[ "$elapsed" -lt 12 ]; check $? "watch --timeout returns promptly (${elapsed}s)"

# 11. watch on a finished job
sql "update jobs set status='succeeded', result='{\"text\":\"done!\"}'::jsonb
     where id='$Q'" > /dev/null
out=$("$BIN" watch "$Q")
[ "$out" = "done!" ]; check $? "watch prints the result of a finished job"

sql "update jobs set status='failed', error='boom' where id='$Q'" > /dev/null
"$BIN" watch "$Q" > /dev/null 2>&1
[ $? -eq 1 ]; check $? "watch exits 1 for a failed job"

# 12. bad input
"$BIN" submit nosuchtype "x" > /dev/null 2>&1
[ $? -ne 0 ]; check $? "an unknown job type is rejected"
"$BIN" submit llm > /dev/null 2>&1
[ $? -ne 0 ]; check $? "submitting with no text is rejected"

rm -rf "$CFG" "$BIN"

echo
if [ "$fails" -gt 0 ]; then
  echo "$fails FAILED"
  exit 1
fi
echo "Go CLI end-to-end tests passed."
