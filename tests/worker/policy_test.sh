#!/usr/bin/env bash
# Tests claudex-worker's policy layer with a stub `claude`. Launches nothing real.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
W="$ROOT/plugin/bin/claudex-worker"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/claudex-wt-XXXXXX")" || { printf '    FAIL: cannot create policy test directory\n' >&2; exit 1; }
[[ -n "$TMP" && -d "$TMP" ]] || { printf '    FAIL: policy test directory is missing\n' >&2; exit 1; }
trap 'rm -rf "$TMP"' EXIT
fails=0 checks=0
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')

check()    { checks=$((checks+1)); if [ "$2" = "$3" ]; then :; else fails=$((fails+1)); echo "    FAIL: $1: got '$2', want '$3'"; fi; }
contains() { checks=$((checks+1)); case "$2" in *"$3"*) ;; *) fails=$((fails+1)); echo "    FAIL: $1: '$3' not in: ${2:0:400}";; esac; }
absent()   { checks=$((checks+1)); case "$2" in *"$3"*) fails=$((fails+1)); echo "    FAIL: $1: '$3' present";; *) ;; esac; }

# Stub claude: records argv + selected env, optionally sleeps, prints a -p JSON result.
mkdir -p "$TMP/bin" "$TMP/state" "$TMP/work"
cat > "$TMP/bin/claude" <<'EOF'
#!/usr/bin/env bash
{
  printf -v argv ' [%s]' "$@"
  printf 'ARGV:%s\n' "$argv"
  echo "BASE_URL=${ANTHROPIC_BASE_URL:-}"
  echo "AUTH_TOKEN=${ANTHROPIC_AUTH_TOKEN:-}"
  echo "CONFIG_DIR=${CLAUDE_CONFIG_DIR:-}"
  echo "HAIKU=${ANTHROPIC_DEFAULT_HAIKU_MODEL:-}"
  echo "SUBAGENT=${CLAUDE_CODE_SUBAGENT_MODEL:-}"
  echo "LEAKED_PARENT=${CLAUDE_CODE_SESSION_ID:-}${CLAUDECODE:-}${SECRET_FROM_PARENT:-}"
  echo "PWD=$PWD"
  echo "STDIN=$(cat)"
} >> "$STUB_LOG"
[ -n "${STUB_SLEEP:-}" ] && sleep "$STUB_SLEEP"
echo '{"type":"result","subtype":"success","is_error":false,"result":"stub report","session_id":"11111111-1111-1111-1111-111111111111","num_turns":3,"usage":{"input_tokens":10,"output_tokens":5}}'
EOF
chmod +x "$TMP/bin/claude"

# Every invocation: isolated config/state, stub claude, proxy management skipped.
w() {
    env -i HOME="$TMP" PATH="$PATH" CLAUDEX_CONFIG_FILE="$TMP/config" CLAUDEX_STATE_DIR="$TMP/state" \
        CLAUDEX_CLAUDE_BIN="$TMP/bin/claude" CLAUDEX_TEST_SKIP_PROXY=1 CLAUDEX_PORT="$PORT" STUB_LOG="$TMP/stub.log" \
        CLAUDE_CODE_SESSION_ID=parent-session CLAUDECODE=1 SECRET_FROM_PARENT=hunter2 "$@"
}
reset() { rm -f "$TMP/config" "$TMP/stub.log"; }

echo "  defaults"
reset
out=$(w "$W" config)
contains "default master switch" "$out" "CLAUDEX=on"
contains "default delegation" "$out" "CLAUDEX_DELEGATION=on-request"
contains "default adversary" "$out" "CLAUDEX_ADVERSARY=on-request"
contains "default tiers" "$out" "CLAUDEX_TIERS=luna,sol,astra"
contains "default worker" "$out" "CLAUDEX_DEFAULT_WORKER=sol"
contains "default adversary model" "$out" "CLAUDEX_ADVERSARY_MODEL=gpt-astra@xhigh"
contains "default parallel" "$out" "CLAUDEX_MAX_PARALLEL=4"
contains "default mode" "$out" "CLAUDEX_WORKER_MODE=edit"

echo "  precedence: env > file > default"
reset
printf 'CLAUDEX_DELEGATION=suggest\nCLAUDEX_MAX_PARALLEL=2\n# comment\n\n' > "$TMP/config"
out=$(w "$W" config)
contains "file overrides default" "$out" "CLAUDEX_DELEGATION=suggest"
contains "file sets parallel" "$out" "CLAUDEX_MAX_PARALLEL=2"
out=$(w CLAUDEX_DELEGATION=auto "$W" config)
contains "env overrides file" "$out" "CLAUDEX_DELEGATION=auto"

echo "  config file is data, never executed"
reset
printf 'CLAUDEX_DELEGATION=auto; touch %s/pwned\nCLAUDEX_TIERS=$(touch %s/pwned2)\n' "$TMP" "$TMP" > "$TMP/config"
out=$(w "$W" config 2>&1); rc=$?
check "rejects bad config" "$rc" "2"
check "no command ran (1)" "$([ -e "$TMP/pwned" ] && echo yes || echo no)" "no"
check "no command ran (2)" "$([ -e "$TMP/pwned2" ] && echo yes || echo no)" "no"

echo "  invalid values are rejected"
reset
out=$(w CLAUDEX_DELEGATION=always "$W" config 2>&1); check "bad delegation" "$?" "2"
out=$(w CLAUDEX_TIERS=luna,pluto "$W" config 2>&1);  check "bad tier" "$?" "2"
out=$(w CLAUDEX_MAX_PARALLEL=0 "$W" config 2>&1);    check "bad parallel" "$?" "2"
out=$(w CLAUDEX_WORKER_MODE=yolo "$W" config 2>&1);  check "yolo can't be a default" "$?" "2"
out=$(w CLAUDEX_ADVERSARY_MODEL='gpt-6-astra@ultra; rm -rf /' "$W" config 2>&1); check "bad adversary model" "$?" "2"
out=$(w CLAUDEX_DEFAULT_WORKER=terra "$W" config); check "legacy default worker accepted" "$?" "0"
for model in gpt-luna gpt-sol gpt-astra gpt-terra gpt-7.2-sol@xhigh gpt-5.6-terra; do
    w CLAUDEX_ADVERSARY_MODEL="$model" "$W" config >/dev/null 2>&1
    check "valid adversary $model" "$?" "0"
done
for model in gpt-solar gpt-7.1.2-sol gpt--sol gpt-7-pluto@high gpt-sol@turbo; do
    w CLAUDEX_ADVERSARY_MODEL="$model" "$W" config >/dev/null 2>&1
    check "invalid adversary $model" "$?" "2"
done

echo "  set writes the file and validates"
reset
w "$W" set CLAUDEX_DELEGATION auto >/dev/null; check "set ok" "$?" "0"
contains "persisted" "$(cat "$TMP/config")" "CLAUDEX_DELEGATION=auto"
w "$W" set CLAUDEX_DELEGATION suggest >/dev/null
check "replaced, not duplicated" "$(grep -c '^CLAUDEX_DELEGATION=' "$TMP/config")" "1"
w "$W" set CLAUDEX_DELEGATION nonsense >/dev/null 2>&1; check "set rejects bad value" "$?" "2"
w "$W" set NOT_A_KEY x >/dev/null 2>&1;                check "set rejects unknown key" "$?" "2"
contains "bad set left file intact" "$(cat "$TMP/config")" "CLAUDEX_DELEGATION=suggest"

echo "  policy line"
reset
out=$(w "$W" policy-line)
contains "mentions policy" "$out" "delegation=on-request"
contains "mentions adversary" "$out" "adversary=on-request"
contains "one line" "$(echo "$out" | wc -l | tr -d ' ')" "1"
out=$(w CLAUDEX=off "$W" policy-line); check "silent when off" "$out" ""
out=$(w CLAUDEX_TIERS=luna,terra "$W" policy-line)
contains "policy mentions terra deprecation" "$out" "terra is deprecated (served by sol)"
out=$(w CLAUDEX_TIERS=luna,terra CLAUDEX_DEFAULT_WORKER=terra CLAUDEX_ADVERSARY_MODEL=gpt-terra "$W" policy-line)
check "deprecation only once" "$(printf '%s' "$out" | python3 -c 'import sys; print(sys.stdin.read().count("terra is deprecated (served by sol)"))')" "1"
out=$(w CLAUDEX_TIERS=luna,terra "$W" status)
contains "status mentions terra deprecation" "$out" "terra is deprecated (served by sol)"
out=$(w CLAUDEX_TIERS=luna,terra "$W" status --json)
check "status JSON deprecations" "$(jq -r '.deprecations[0]' <<<"$out")" "terra is deprecated (served by sol)"
check "status JSON models null without proxy" "$(jq -r '.models' <<<"$out")" "null"

echo "  master switch and tier gating are enforced by the worker itself"
reset
out=$(echo "task" | w CLAUDEX=off "$W" run sol 2>&1); check "off -> exit 3" "$?" "3"
check "off -> claude never ran" "$([ -e "$TMP/stub.log" ] && echo ran || echo no)" "no"
out=$(echo "task" | w CLAUDEX_TIERS=luna,terra "$W" run astra 2>&1); check "tier blocked -> exit 4" "$?" "4"
contains "tier blocked message" "$out" "astra"
out=$(echo "task" | w CLAUDEX_TIERS=luna,terra "$W" run adversary 2>&1); check "adversary respects tier gate" "$?" "4"
out=$(echo "task" | w "$W" run pluto 2>&1); check "unknown tier -> exit 2" "$?" "2"
out=$(w "$W" run sol </dev/null 2>&1); check "empty brief -> exit 2" "$?" "2"

echo "  run: child gets an isolated, GPT-only environment"
reset
out=$(echo "do the thing" | w "$W" run sol --cwd "$TMP/work" --effort max)
check "run ok" "$?" "0"
contains "report printed" "$out" "stub report"
contains "session id surfaced" "$out" "session=11111111-1111-1111-1111-111111111111"
contains "footer names model" "$out" "model=gpt-sol@max"
log=$(cat "$TMP/stub.log")
contains "model arg" "$log" "[--model] [gpt-sol@max]"
contains "headless" "$log" "[-p]"
contains "json output" "$log" "[--output-format] [json]"
contains "base url is the isolated local proxy" "$log" "BASE_URL=http://127.0.0.1:$PORT"
contains "dummy token, not a real credential" "$log" "AUTH_TOKEN=claudex-local"
contains "separate config dir" "$log" "CONFIG_DIR=$TMP/state/claude-config"
contains "background model stays GPT" "$log" "HAIKU=gpt-luna"
contains "sub-subagents stay on tier" "$log" "SUBAGENT=gpt-sol@max"
check "parent env is scrubbed" "$(grep '^LEAKED_PARENT=' <<<"$log")" "LEAKED_PARENT="
contains "runs in cwd" "$log" "PWD=$TMP/work"
contains "brief on stdin" "$log" "STDIN=do the thing"
contains "edit mode" "$log" "[--permission-mode] [acceptEdits]"
settings=$(grep '^ARGV:' <<<"$log" | sed -n 's/.*\[--settings\] \[\(.*\)\]$/\1/p')
check "edit mode turns the Bash sandbox on" "$(jq -r '.sandbox.enabled' <<<"$settings" 2>/dev/null)" "true"
check "sandbox fails closed if unavailable" "$(jq -r '.sandbox.failIfUnavailable' <<<"$settings" 2>/dev/null)" "true"
check "no unsandboxed retry" "$(jq -r '.sandbox.allowUnsandboxedCommands' <<<"$settings" 2>/dev/null)" "false"
check "home directory is unreadable to worker Bash" "$(jq -r --arg h "$TMP" '.sandbox.filesystem.denyRead | index($h) != null' <<<"$settings" 2>/dev/null)" "true"
check "working directory is readable again" "$(jq -r --arg d "$TMP/work" '.sandbox.filesystem.allowRead | index($d) != null' <<<"$settings" 2>/dev/null)" "true"
contains "edit mode pre-approves only sandboxed Bash" "$log" "[--allowedTools] [Bash]"
absent "Write is never pre-approved (it would escape the working directory)" "$log" "[--allowedTools] [Read"

echo "  modes"
reset
echo "review" | w "$W" run astra --mode read >/dev/null
log=$(cat "$TMP/stub.log")
contains "read mode is dontAsk" "$log" "[--permission-mode] [dontAsk]"
absent "read mode pre-approves nothing, so reads outside the working directory are denied" "$log" "--allowedTools"
absent "read mode has no Edit" "$log" "Edit"
absent "read mode has no Bash" "$log" "Bash"
contains "astra default effort" "$log" "[gpt-astra@xhigh]"
reset
echo "attack this" | w CLAUDEX_WORKER_MODE=edit "$W" run adversary >/dev/null
log=$(cat "$TMP/stub.log")
contains "adversary uses configured model" "$log" "[gpt-astra@xhigh]"
contains "adversary is always read-only" "$log" "[--permission-mode] [dontAsk]"
reset
echo "attack this" | w CLAUDEX_ADVERSARY_MODEL=gpt-sol@max "$W" run adversary >/dev/null
contains "adversary can be gpt-6-sol" "$(cat "$TMP/stub.log")" "[gpt-sol@max]"
reset
echo "attack this" | w CLAUDEX_ADVERSARY_MODEL=gpt-5.6-sol "$W" run adversary >/dev/null
contains "superseded adversary slug still runs" "$(cat "$TMP/stub.log")" "[gpt-5.6-sol@high]"
reset
echo "attack this" | w CLAUDEX_ADVERSARY_MODEL=gpt-terra "$W" run adversary >/dev/null
contains "deprecated adversary alias reaches proxy" "$(cat "$TMP/stub.log")" "[--model] [gpt-terra]"
echo "x" | w CLAUDEX_TIERS=luna CLAUDEX_ADVERSARY_MODEL=gpt-5.6-sol "$W" run adversary >/dev/null 2>&1
check "superseded slug is gated as its tier" "$?" "4"
reset
echo "task" | w CLAUDEX_TIERS=luna,terra "$W" run terra >/dev/null
contains "terra tier reaches proxy as terra" "$(cat "$TMP/stub.log")" "[--model] [gpt-terra]"
reset
echo "task" | w CLAUDEX_TIERS=luna,terra "$W" run terra --effort xhigh >/dev/null
contains "terra explicit effort is forwarded" "$(cat "$TMP/stub.log")" "[--model] [gpt-terra@xhigh]"
check "terra and sol deduplicated" "$(echo task | w CLAUDEX_TIERS=luna,terra "$W" run sol >/dev/null 2>&1; echo $?)" "0"
reset
echo "x" | w "$W" run adversary --mode edit >/dev/null 2>&1; check "adversary refuses edit mode" "$?" "2"
reset
echo "x" | w "$W" run sol --mode yolo >/dev/null
contains "yolo only when asked per call" "$(cat "$TMP/stub.log")" "[--permission-mode] [bypassPermissions]"
absent "yolo is the only mode without the sandbox" "$(cat "$TMP/stub.log")" "failIfUnavailable"

echo "  resume"
reset
echo "follow up" | w "$W" resume 11111111-1111-1111-1111-111111111111 sol >/dev/null
contains "resume flag" "$(cat "$TMP/stub.log")" "[--resume] [11111111-1111-1111-1111-111111111111]"
echo "x" | w "$W" resume 'bad id; rm -rf /' sol >/dev/null 2>&1; check "resume validates id" "$?" "2"

echo "  parallel limit queues instead of failing"
reset
start=$(date +%s%N)
for i in 1 2 3; do echo "job $i" | w CLAUDEX_MAX_PARALLEL=2 STUB_SLEEP=1 "$W" run luna >/dev/null & done
wait
elapsed_ms=$(( ($(date +%s%N) - start) / 1000000 ))
check "all three ran" "$(grep -c '^ARGV:' "$TMP/stub.log")" "3"
check "third waited for a slot (>=1.9s total)" "$(( elapsed_ms >= 1900 ))" "1"

echo "  start / wait / result"
reset
job=$(echo "bg task" | w STUB_SLEEP=1 "$W" start terra)
check "start returns a job id" "$([[ "$job" =~ ^[a-z0-9-]+$ ]] && echo ok || echo "bad:$job")" "ok"
out=$(w "$W" wait "$job" --timeout 0 2>&1); check "wait times out while running -> exit 5" "$?" "5"
out=$(w "$W" wait "$job" --timeout 10);      check "wait succeeds" "$?" "0"
contains "wait prints report" "$out" "stub report"
contains "start terra sends the terra alias" "$(cat "$TMP/stub.log")" "[--model] [gpt-terra]"
contains "result replays report" "$(w "$W" result "$job")" "stub report"
w "$W" result 'no/such/../job' >/dev/null 2>&1; check "result validates job id" "$?" "2"

echo "  $checks checks, $fails failures"
exit $((fails > 0))
