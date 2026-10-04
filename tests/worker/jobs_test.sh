#!/usr/bin/env bash
# Exercises the worker job registry without a real Claude process or proxy.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
W="$ROOT/plugin/bin/claudex-worker"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/claudex-jobs-XXXXXX")" && [ -n "$TMP" ] && [ -d "$TMP" ] || { printf '    FAIL: cannot create jobs test directory\n' >&2; exit 1; }
fails=0 checks=0
check()    { checks=$((checks+1)); if [ "$2" != "$3" ]; then fails=$((fails+1)); printf '    FAIL: %s: got %q, want %q\n' "$1" "$2" "$3"; fi; }
contains() { checks=$((checks+1)); case "$2" in *"$3"*) ;; *) fails=$((fails+1)); printf '    FAIL: %s: %q not in %q\n' "$1" "$3" "${2:0:400}";; esac; }
absent()   { checks=$((checks+1)); case "$2" in *"$3"*) fails=$((fails+1)); printf '    FAIL: %s: %q present\n' "$1" "$3";; *) ;; esac; }
json()     { jq -er "$1" <<<"$2" 2>/dev/null || true; }
# A group is live if it has any non-zombie process, including descendants after the leader exits.
group_members() {
    local pgid=$1 f stat rest
    for f in /proc/[0-9]*/stat; do
        [[ -r "$f" ]] || continue
        stat=$(< "$f") || continue
        rest=${stat##*) }
        set -- $rest
        [[ ${3:-} == "$pgid" && ${1:-} != Z ]] && return 0
    done
    return 1
}
job_count() { local n; n=$(compgen -G "$TMP/state/jobs/*" | wc -l); printf '%s' "$n"; }
cleanup() {
    if [[ -d "$TMP/state/jobs" ]]; then
        local f pid
        for f in "$TMP"/state/jobs/*/child.json; do
            [[ -f "$f" ]] || continue
            if saved_identity_alive "$f"; then
                pid=$(jq -r '.pgid' "$f")
                kill -KILL -- "-$pid" 2>/dev/null || true
            fi
        done
    fi
    if [[ -n "${sentinel:-}" ]]; then
        if saved_identity_alive "$TMP/sentinel.json"; then kill -- "-$sentinel" 2>/dev/null || true; fi
        wait "$sentinel" 2>/dev/null || true
    fi
    rm -rf -- "$TMP"
}
trap cleanup EXIT
mkdir -p "$TMP/bin" "$TMP/state" "$TMP/work"

printf '%s\n' '#!/usr/bin/env bash' \
    'printf "[%s] " "$@" >> "$STUB_LOG"; printf "\n" >> "$STUB_LOG"' \
    'printf "%s\n" "$BASHPID" >> "$STUB_PIDS"' \
    '[[ -z "${STUB_IGNORE_TERM:-}" ]] || trap "" TERM' \
    'if [[ -n "${STUB_SPAWN_CHILD:-}" ]]; then bash -c '\''trap "" TERM; exec sleep 300'\'' & printf "%s\n" "$!" > "$STUB_DESCENDANT"; fi' \
    '[[ -z "${STUB_SLEEP:-}" ]] || sleep "$STUB_SLEEP"' \
    'if [[ -n "${STUB_FINDINGS_FILE:-}" ]]; then' \
    '  jq -cn --rawfile findings "$STUB_FINDINGS_FILE" '\''{type:"result",result:("stub report"+$findings),session_id:"11111111-1111-1111-1111-111111111111",num_turns:1}'\''' \
    'else' \
    '  jq -cn --arg result "stub report${STUB_FINDINGS:-}" '\''{type:"result",result:$result,session_id:"11111111-1111-1111-1111-111111111111",num_turns:1}'\''' \
    'fi' \
    'exit "${STUB_RC:-0}"' > "$TMP/bin/claude"
chmod +x "$TMP/bin/claude"
# The worker only receives this isolated environment, never the current user's credentials.
w() {
    env -i HOME="$TMP" PATH="$PATH" CLAUDEX_CONFIG_FILE="$TMP/config" CLAUDEX_STATE_DIR="$TMP/state" \
        CLAUDEX_CLAUDE_BIN="$TMP/bin/claude" CLAUDEX_TEST_SKIP_PROXY=1 \
        STUB_LOG="$TMP/stub.log" STUB_PIDS="$TMP/stub.pids" STUB_DESCENDANT="$TMP/stub.descendant" "$@"
}
reset_jobs() {
    local d i
    for d in "$TMP"/state/jobs/*; do
        [[ -d "$d" && -f "$d/rc" ]] || continue
        for ((i=0;i<30;i++)); do
            compgen -G "$d/.raw.*" >/dev/null || break
            sleep 0.05
        done
    done
    for ((i=0;i<20;i++)); do
        rm -rf "$TMP/state/jobs" 2>/dev/null && break
        sleep 0.05
    done
    if [[ -d "$TMP/state/jobs" ]]; then fails=$((fails+1)); printf '    FAIL: could not clear finished jobs\n'; fi
    rm -f "$TMP/stub.log" "$TMP/stub.pids" "$TMP/config" "$TMP/stub.descendant"
}
finish() {
    local job=$1 n
    for ((n=0; n<100; n++)); do [[ -f "$TMP/state/jobs/$job/rc" ]] && return 0; sleep 0.1; done
    return 1
}
saved_identity_alive() {
    local file=$1 pid current stat rest
    pid=$(jq -er '.pid | select(type=="number" and .>1)' "$file" 2>/dev/null) || return 1
    [[ -r "/proc/$pid/stat" ]] || return 1
    stat=$(< "/proc/$pid/stat")
    rest=${stat##*) }
    set -- $rest
    [[ ${1:-} != Z ]] || return 1
    current=$(identity "$pid" "${3:-0}") || return 1
    jq -e --argjson current "$current" \
        '.pid==$current.pid and .pgid==$current.pgid and (.starttime|tostring)==($current.starttime|tostring) and .boot_id==$current.boot_id' "$file" >/dev/null 2>&1
}
identity() { # A job record's process identity; do not signal it without verifying it.
    local pid=$1 pgid=$2 stat
    stat=$(<"/proc/$pid/stat")
    stat=${stat##*) }
    stat=${stat#* } # field 3
    # after stripping field 3, field 22 is now shell word 19
    set -- $stat
    jq -n --argjson pid "$pid" --argjson pgid "$pgid" --arg starttime "${19}" \
        --arg boot_id "$(< /proc/sys/kernel/random/boot_id)" \
        '{pid:$pid,pgid:$pgid,starttime:$starttime,boot_id:$boot_id}'
}

printf '  run records one job and preserves its stdout footer\n'
reset_jobs
out=$(printf 'task\n' | w "$W" run sol --cwd "$TMP/work"); check 'run exit' "$?" 0
check 'run one job' "$(job_count)" 1
dir=("$TMP"/state/jobs/*); job=${dir[0]##*/}
check 'job id format' "$([[ "$job" =~ ^[0-9]+-[0-9a-f]{8}$ ]] && printf yes || printf no)" yes
check 'meta shape' "$(jq -r --arg cwd "$TMP/work" '.tier=="sol" and .kind=="worker" and .model=="gpt-sol@high" and .mode=="edit" and .cwd==$cwd and .origin=="bash" and .owner==null' "$dir/meta.json" 2>/dev/null)" true
check 'run rc' "$(cat "$dir/rc" 2>/dev/null)" 0
check 'brief private' "$(stat -c %a "$dir/brief")" 600
check 'report private' "$(stat -c %a "$dir/out")" 600
check 'session' "$(cat "$dir/session" 2>/dev/null)" 11111111-1111-1111-1111-111111111111
contains 'recorded footer' "$(cat "$dir/out" 2>/dev/null)" '--- claudex-worker ---'
contains 'recorded follow-up' "$(cat "$dir/out" 2>/dev/null)" 'follow up with:'
check 'stdout unchanged' "$out" "$(cat "$dir/out" 2>/dev/null)"

printf '  ownership, start and finish\n'
reset_jobs
printf 'x\n' | w CLAUDEX_JOB_ORIGIN=mod CLAUDEX_JOB_OWNER=abc "$W" run luna >/dev/null
dir=("$TMP"/state/jobs/*)
check 'mod origin' "$(jq -r .origin "${dir[0]}/meta.json" 2>/dev/null)" mod
check 'mod owner' "$(jq -r .owner "${dir[0]}/meta.json" 2>/dev/null)" abc
reset_jobs
job=$(printf 'x\n' | w STUB_SLEEP=2 "$W" start sol); check 'start exit/id' "$([[ "$job" =~ ^[0-9]+-[0-9a-f]{8}$ ]] && printf yes || printf no)" yes
check 'start one dir' "$(job_count)" 1
# The child can take a short time to spawn after start prints the id.
for ((i=0;i<40;i++)); do state=$(w "$W" jobs --json --id "$job" 2>/dev/null); [[ "$(json '.[0].state' "$state")" == running ]] && break; sleep 0.05; done
check 'running state' "$(json '.[0].state' "$state")" running
out=$(w "$W" wait "$job" --timeout 10); check 'wait exit' "$?" 0
check 'done state' "$(json '.[0].state' "$(w "$W" jobs --json --id "$job")")" done
contains 'wait report' "$out" 'stub report'
reset_jobs
job=$(printf 'x\n' | w STUB_RC=1 "$W" start sol); finish "$job" || true
check 'failing rc published' "$(cat "$TMP/state/jobs/$job/rc" 2>/dev/null)" 1
check 'failed state' "$(json '.[0].state' "$(w "$W" jobs --json --id "$job")")" failed
w "$W" wait "$job" --timeout 0 >/dev/null 2>&1; check 'failed wait exit' "$?" 1
reset_jobs
job=$(printf 'x\n' | w CLAUDEX_CLAUDE_BIN=/nonexistent "$W" start sol); finish "$job" || true
check 'spawn failure publishes rc' "$([[ -s "$TMP/state/jobs/$job/rc" ]] && printf yes || printf no)" yes
check 'spawn failure state' "$(json '.[0].state' "$(w "$W" jobs --json --id "$job")")" failed

printf '  queued supervisors and setup failures\n'
reset_jobs
queued=()
for ((i=0;i<4;i++)); do queued+=("$(printf 'x\n' | w STUB_SLEEP=300 "$W" start sol)"); done
for job in "${queued[@]}"; do
    for ((i=0;i<100;i++)); do [[ -s "$TMP/state/jobs/$job/child.json" ]] && break; sleep 0.05; done
done
waiting=$(printf 'x\n' | w "$W" start sol)
check 'queued job starts nonterminal' "$(json '.[0].state' "$(w "$W" jobs --json --id "$waiting")")" running
sleep 0.4
check 'queued job remains nonterminal' "$(json '.[0].state' "$(w "$W" jobs --json --id "$waiting")")" running
for job in "${queued[@]}"; do w "$W" cancel "$job" >/dev/null 2>&1 || true; done
finish "$waiting" || true
check 'queued job runs after slot frees' "$(json '.[0].state' "$(w "$W" jobs --json --id "$waiting")")" done

reset_jobs
queued=()
for ((i=0;i<4;i++)); do queued+=("$(printf 'x\n' | w STUB_SLEEP=300 "$W" start sol)"); done
for job in "${queued[@]}"; do
    for ((i=0;i<100;i++)); do [[ -s "$TMP/state/jobs/$job/child.json" ]] && break; sleep 0.05; done
done
waiting=$(printf 'x\n' | w "$W" start sol)
check 'fifth job has no anchor' "$([[ -e "$TMP/state/jobs/$waiting/child.json" ]] && printf no || printf yes)" yes
w "$W" cancel "$waiting" > "$TMP/queued-cancel" 2>&1
check 'queued cancel succeeds' "$?" 0
finish "$waiting" || true
check 'queued cancel publishes 130' "$(< "$TMP/state/jobs/$waiting/rc")" 130
check 'queued cancel never launches Claude' "$(wc -l < "$TMP/stub.pids")" 4
for job in "${queued[@]}"; do w "$W" cancel "$job" >/dev/null 2>&1 || true; done

# Fail only the sandbox-settings jq call, not metadata or result parsing.
real_jq=$(command -v jq)
printf '#!/usr/bin/env bash\nfor arg in "$@"; do [[ "$arg" != *autoAllowBashIfSandboxed* ]] || exit 71; done\nexec %q "$@"\n' "$real_jq" > "$TMP/bin/jq"
chmod +x "$TMP/bin/jq"
reset_jobs
printf 'x\n' | PATH="$TMP/bin:$PATH" w "$W" run sol >/dev/null 2>&1
check 'sandbox failure never launches claude' "$([[ -s "$TMP/stub.pids" ]] && printf no || printf yes)" yes
check 'sandbox failure is terminal' "$(jq -r . "$TMP/state/jobs/"*/rc 2>/dev/null)" 1
rm -f "$TMP/bin/jq"

printf '  supervisor signal during worker handoff\n'
reset_jobs
# DEBUG fires after Bash forks the worker but before it assigns $! to ACTIVE_WORKER_PID.
# Block settings generation in the fork so it cannot reach the anchor before TERM.
printf '%s\n' '[[ -n "${CLAUDEX_JOB_ID:-}" ]] || return 0' \
    'set -T' \
    'trap '\''if [[ "$BASH_COMMAND" == "ACTIVE_WORKER_PID=\$!" ]]; then trap - DEBUG; printf "%s\n" "$!" > "$CLAUDEX_STATE_DIR/handoff-worker"; kill -TERM "$BASHPID"; fi'\'' DEBUG' > "$TMP/handoff-env"
printf '#!/usr/bin/env bash\nfor arg in "$@"; do if [[ "$arg" == *autoAllowBashIfSandboxed* ]]; then sleep 2; fi; done\nexec %q "$@"\n' "$real_jq" > "$TMP/bin/jq"
chmod +x "$TMP/bin/jq"
job=$(printf 'x\n' | PATH="$TMP/bin:$PATH" w BASH_ENV="$TMP/handoff-env" "$W" start sol)
finish "$job" || true
check 'TERM at handoff was triggered' "$([[ -s "$TMP/state/handoff-worker" ]] && printf yes || printf no)" yes
check 'handoff TERM publishes rc' "$([[ -s "$TMP/state/jobs/$job/rc" ]] && printf yes || printf no)" yes
worker=$(< "$TMP/state/handoff-worker")
check 'handoff worker reaped before rc' "$([[ -d /proc/$worker ]] && printf no || printf yes)" yes
sleep 2.5
check 'handoff TERM never launches Claude' "$([[ -s "$TMP/stub.pids" ]] && printf no || printf yes)" yes
rm -f "$TMP/bin/jq"

printf '  TERM at both anchor startup boundaries\n'
for boundary in forked registered; do
    reset_jobs
    # Before go, the anchor must exit on stop without a hold or group signal.
    prego_hook='() { if [[ ( "${1:-}" == -TERM || "${1:-}" == -KILL ) && "${2:-}" == -- && "${3:-}" == -* ]]; then printf "%s\n" "$1" >> "$CLAUDEX_STATE_DIR/prego-signals"; fi; builtin kill "$@"; }'
    # DEBUG runs in run_worker after the anchor fork, or after child.json is
    # published but before the supervisor can grant go.
    printf '%s\n' '[[ -n "${CLAUDEX_JOB_ID:-}" ]] || return 0' \
        'if [[ "$0" == claudex-anchor ]]; then' \
        '  trap '\''if [[ "$BOUNDARY" == registered && "$BASH_COMMAND" == acknowledge_hold && -n "${job_dir:-}" && ! -f "$job_dir/go" ]]; then for ((n=0;n<80;n++)); do [[ ! -f "$job_dir/hold" && ! -f "$job_dir/go" ]] || break; sleep 0.05; done; fi; if [[ -n "${job_dir:-}" && -f "$job_dir/held" && ! -f "$job_dir/go" ]]; then sleep 0.4; fi'\'' DEBUG' \
        'else' \
        '  set -T' \
        '  trap '\''if [[ "${FUNCNAME[0]:-}" == run_worker && ( ( "$BOUNDARY" == forked && "$BASH_COMMAND" == "child=\$!" ) || ( "$BOUNDARY" == registered && "$BASH_COMMAND" == "flock -u \"\$LAUNCH_FD\"" ) ) ]]; then trap - DEBUG; printf "%s\n" "$BASHPID" > "$CLAUDEX_STATE_DIR/boundary-hit"; kill -TERM "$BASHPID"; fi'\'' DEBUG' \
        'fi' > "$TMP/boundary-env"
    job=$(printf 'x\n' | w "BASH_FUNC_kill%%=$prego_hook" BASH_ENV="$TMP/boundary-env" BOUNDARY="$boundary" "$W" start sol)
    finish "$job" || true
    check "$boundary TERM hit worker" "$([[ -s "$TMP/state/boundary-hit" ]] && printf yes || printf no)" yes
    check "$boundary TERM publishes rc" "$([[ -f "$TMP/state/jobs/$job/rc" ]] && printf yes || printf no)" yes
    check "$boundary TERM prevents Claude" "$([[ -s "$TMP/stub.pids" ]] && printf no || printf yes)" yes
    check "$boundary pre-go sends no group signals" "$([[ -s "$TMP/state/prego-signals" ]] && printf no || printf yes)" yes
    check "$boundary pre-go anchor exits on its own" "$(saved_identity_alive "$TMP/state/jobs/$job/child.json" && printf no || printf yes)" yes
    check "$boundary pre-go creates no hold" "$([[ -e "$TMP/state/jobs/$job/hold" || -e "$TMP/state/jobs/$job/held" ]] && printf no || printf yes)" yes
    rm -f "$TMP/state/prego-signals"
    rm -f "$TMP/state/boundary-hit"
done

printf '  synchronous preflight refuses without jobs\n'
for spec in tier off empty cwd; do
    reset_jobs
    case "$spec" in
        tier) run=$(printf 'x\n' | w CLAUDEX_TIERS=luna "$W" run sol 2>&1); r=$?; started=$(printf 'x\n' | w CLAUDEX_TIERS=luna "$W" start sol 2>&1); s=$? ;;
        off) run=$(printf 'x\n' | w CLAUDEX=off "$W" run sol 2>&1); r=$?; started=$(printf 'x\n' | w CLAUDEX=off "$W" start sol 2>&1); s=$? ;;
        empty) run=$(w "$W" run sol </dev/null 2>&1); r=$?; started=$(w "$W" start sol </dev/null 2>&1); s=$? ;;
        cwd) run=$(printf 'x\n' | w "$W" run sol --cwd "$TMP/absent" 2>&1); r=$?; started=$(printf 'x\n' | w "$W" start sol --cwd "$TMP/absent" 2>&1); s=$? ;;
    esac
    check "$spec preflight exit" "$s" "$r"
    check "$spec preflight message" "$started" "$run"
    check "$spec preflight creates no job" "$(job_count)" 0
done
reset_jobs
mkdir -p "$TMP/state/jobs/1790909617-abcdefab"
printf '{"id":"1790909617-abcdefab","tier":"sol","kind":"worker","model":"gpt-6-sol@high","mode":"edit","cwd":"%s","started":1790909617,"origin":"bash","owner":null}\n' "$TMP/work" > "$TMP/state/jobs/1790909617-abcdefab/meta.json"
printf 'x\n' > "$TMP/state/jobs/1790909617-abcdefab/brief"
out=$(printf 'x\n' | w CLAUDEX_JOB_ID=1790909617-abcdefab CLAUDEX=off "$W" run sol 2>&1)
check 'adopted preflight exit' "$?" 3
check 'adopted preflight publishes rc' "$(cat "$TMP/state/jobs/1790909617-abcdefab/rc" 2>/dev/null)" 3
contains 'adopted preflight message' "$out" 'claudex is disabled'
# Change config during new_job's metadata generation, after start has passed its preflight.
printf '#!/usr/bin/env bash\nfor arg in "$@"; do if [[ "$arg" == *"{id:\$id,tier:\$tier"* ]]; then printf "CLAUDEX_MAX_PARALLEL=bad\\n" > "$CLAUDEX_CONFIG_FILE"; fi; done\nexec %q "$@"\n' "$real_jq" > "$TMP/bin/jq"
chmod +x "$TMP/bin/jq"
reset_jobs
job=$(printf 'x\n' | PATH="$TMP/bin:$PATH" w "$W" start sol 2>/dev/null)
finish "$job" || true
rm -f "$TMP/config"
check 'invalid adopted policy publishes rc' "$([[ -f "$TMP/state/jobs/$job/rc" ]] && printf yes || printf no)" yes
w "$W" wait "$job" --timeout 0 > "$TMP/adopted-wait" 2>&1
check 'invalid adopted policy wait exit' "$?" 2
contains 'invalid adopted policy wait explains failure' "$(< "$TMP/adopted-wait")" 'invalid setting in'
result=$(w "$W" result "$job" 2>&1)
check 'invalid adopted policy result exit' "$?" 0
[[ "$result" != *'no such job'* ]] || printf '    adopted diagnostics: rc=%s out=%s err=%s result=%s\n' "$(< "$TMP/state/jobs/$job/rc")" "$(< "$TMP/state/jobs/$job/out")" "$(< "$TMP/state/jobs/$job/err")" "$result"
contains 'invalid adopted policy result explains failure' "$result" 'CLAUDEX_MAX_PARALLEL=bad'
rm -f "$TMP/bin/jq" "$TMP/config"

printf '  cancellation interrupts token refresh\n'
reset_jobs
mkdir -p "$TMP/.codex"
token=$(printf '{"exp":1}' | base64 -w0 | tr '/+' '_-' | tr -d '=')
printf '{"tokens":{"access_token":"a.%s.b"}}\n' "$token" > "$TMP/.codex/auth.json"
printf 'testing\n' > "$TMP/state/instance"
printf '#!/usr/bin/env bash\nprintf '\''{"service":"claudex-proxy","instance":"testing"}\n'\''\n' > "$TMP/bin/curl"
printf '#!/usr/bin/env bash\ntrap '\''printf "TERM\\n" >> "$CLAUDEX_STATE_DIR/refresh-signals"'\'' TERM\nprintf "%%s\\n" "$BASHPID" > "$CLAUDEX_STATE_DIR/refresh-pid"\nwhile [[ ! -f "$CLAUDEX_STATE_DIR/release-refresh" ]]; do sleep 0.1; done\nprintf "done\\n" > "$CLAUDEX_STATE_DIR/refresh-finished"\n' > "$TMP/bin/codex"
chmod +x "$TMP/bin/curl" "$TMP/bin/codex"
refresh_hook='() { if [[ "${1:-}" == -TERM && "${2:-}" =~ ^[0-9]+$ ]]; then printf "%s\n" "$2" >> "$CLAUDEX_STATE_DIR/refresh-kills"; fi; builtin kill "$@"; }'
job=$(printf 'x\n' | PATH="$TMP/bin:$PATH" w "BASH_FUNC_kill%%=$refresh_hook" CLAUDEX_TEST_SKIP_PROXY= "$W" start sol)
for ((i=0;i<60;i++)); do [[ -s "$TMP/state/refresh-pid" ]] && break; sleep 0.05; done
check 'slow codex refresh reached' "$([[ -s "$TMP/state/refresh-pid" ]] && printf yes || printf no)" yes
started=$(date +%s)
PATH="$TMP/bin:$PATH" w CLAUDEX_TEST_SKIP_PROXY= "$W" cancel "$job" > "$TMP/refresh-cancel" 2>&1
check 'slow refresh cancel accepted' "$?" 0
finish "$job" || true
check 'slow refresh cancelled in seconds' "$(( $(date +%s) - started <= 5 ))" 1
check 'slow refresh publishes 130' "$(< "$TMP/state/jobs/$job/rc")" 130
check 'slow refresh never launches Claude' "$([[ -s "$TMP/stub.pids" ]] && printf no || printf yes)" yes
refresh=$(< "$TMP/state/refresh-pid")
check 'stop never signals refresh PID' "$([[ -s "$TMP/state/refresh-kills" ]] && printf no || printf yes)" yes
check 'refresh still runs after job stops' "$([[ -d /proc/$refresh && ! -f "$TMP/state/refresh-finished" ]] && printf yes || printf no)" yes
check 'refresh received no TERM' "$([[ -s "$TMP/state/refresh-signals" ]] && printf no || printf yes)" yes
: > "$TMP/state/release-refresh"
for ((i=0;i<60;i++)); do [[ -f "$TMP/state/refresh-finished" ]] && break; sleep 0.05; done
check 'refresh finishes independently' "$([[ -f "$TMP/state/refresh-finished" ]] && printf yes || printf no)" yes
rm -f "$TMP/bin/curl" "$TMP/bin/codex" "$TMP/.codex/auth.json"

printf '  hold stays asserted across a timed-out acknowledgment and retry\n'
reset_jobs
setsid sleep 300 >/dev/null 2>&1 & sentinel=$!
for ((i=0;i<20;i++)); do [[ -f "/proc/$sentinel/stat" ]] && break; sleep 0.05; done
identity "$sentinel" "$sentinel" > "$TMP/sentinel.json"
# Stop the anchor immediately before publishing held, after it has checked hold.
# On the old implementation the supervisor pauses at its next attempt's clear,
# leaving the hold absent while that earlier acknowledgment is still in flight.
printf '%s\n' 'if [[ "$0" == claudex-anchor ]]; then' \
    '  set -T' \
    '  trap '\''if [[ "$BASH_COMMAND" == mv*".held."* && ! -f "$job_dir/retry-paused" ]]; then : > "$job_dir/retry-paused"; while [[ ! -f "$job_dir/retry-allow-ack" ]]; do sleep 0.01; done; fi'\'' DEBUG' \
    'else' \
    '  set -T' \
    '  trap '\''if [[ "$BASH_COMMAND" == atomic_file*"/hold"* && "$BASHPID" == "$$" ]]; then printf "hold\n" >> "$WORK_DIR/retry-hold-creations"; fi; if [[ "${FUNCNAME[0]:-}" == terminate_group && "$BASH_COMMAND" == rm*"/held"* ]]; then if [[ -f "$WORK_DIR/retry-first" ]]; then : > "$WORK_DIR/retry-interposed"; while [[ ! -f "$WORK_DIR/retry-allow-ack" ]]; do sleep 0.01; done; else : > "$WORK_DIR/retry-first"; fi; fi'\'' DEBUG' \
    'fi' > "$TMP/retry-env"
retry_kill_hook='() { if [[ ( "${1:-}" == -TERM || "${1:-}" == -KILL ) && "${2:-}" == -- && "${3:-}" == -* ]]; then dir="$CLAUDEX_STATE_DIR/jobs/$CLAUDEX_JOB_ID"; if [[ -f "$dir/hold" ]] && jq -e --slurpfile saved "$dir/child.json" ". == \$saved[0]" "$dir/held" >/dev/null 2>&1 && identity_alive "$dir/child.json"; then printf "held\n" >> "$dir/retry-signals"; else printf "unheld\n" >> "$dir/retry-signals"; fi; fi; builtin kill "$@"; }'
retry_rm_hook='() { local dir="$CLAUDEX_STATE_DIR/jobs/$CLAUDEX_JOB_ID" arg early=false; for arg in "$@"; do if [[ "$arg" == "$dir/hold" && -f "$dir/hold" ]] && identity_alive "$dir/child.json"; then early=true; fi; done; command rm "$@"; if [[ "$early" == true ]]; then : > "$dir/retry-hold-removed-early"; fi; }'
job=$(printf 'x\n' | w BASH_ENV="$TMP/retry-env" "BASH_FUNC_kill%%=$retry_kill_hook" "BASH_FUNC_rm%%=$retry_rm_hook" STUB_SLEEP=300 STUB_IGNORE_TERM=1 "$W" start sol)
retry_dir="$TMP/state/jobs/$job"
for ((i=0;i<100;i++)); do [[ -f "$retry_dir/go" && -s "$TMP/stub.pids" ]] && break; sleep 0.05; done
check 'retry job passed go' "$([[ -f "$retry_dir/go" && -s "$TMP/stub.pids" ]] && printf yes || printf no)" yes
w "$W" cancel "$job" > "$TMP/retry-cancel" 2>&1 & retry_requester=$!
for ((i=0;i<100;i++)); do [[ -f "$retry_dir/retry-paused" ]] && break; sleep 0.05; done
check 'anchor paused after hold check' "$([[ -f "$retry_dir/retry-paused" ]] && printf yes || printf no)" yes
# Allow the first 2-second acknowledgment wait to expire. The old retry is
# interposed before it can create a new hold; the fixed retry has no such gap.
for ((i=0;i<55;i++)); do [[ -f "$retry_dir/retry-interposed" ]] && break; sleep 0.05; done
check 'hold persists through acknowledgment timeout' "$([[ -f "$retry_dir/hold" && ! -f "$retry_dir/retry-hold-removed-early" ]] && printf yes || printf no)" yes
: > "$retry_dir/retry-allow-ack"
for ((i=0;i<100;i++)); do [[ -f "$retry_dir/held" || -f "$retry_dir/rc" ]] && break; sleep 0.02; done
check 'hold persists when delayed acknowledgment arrives' "$([[ -f "$retry_dir/hold" || -f "$retry_dir/rc" ]] && printf yes || printf no)" yes
wait "$retry_requester"; check 'retry cancel accepted' "$?" 0
finish "$job" || true
check 'retry finishes after missed hold window' "$([[ -f "$retry_dir/rc" ]] && printf yes || printf no)" yes
check 'retry publishes cancellation' "$(cat "$retry_dir/rc" 2>/dev/null)" 130
check 'retry removes anchor' "$(saved_identity_alive "$retry_dir/child.json" && printf no || printf yes)" yes
check 'retry group signals require live anchor and asserted hold' "$([[ -f "$retry_dir/retry-signals" && "$(< "$retry_dir/retry-signals")" != *unheld* ]] && printf yes || printf no)" yes
check 'one hold created for the stop request' "$(wc -l < "$retry_dir/retry-hold-creations" 2>/dev/null)" 1
check 'unrelated sentinel survives retry' "$(saved_identity_alive "$TMP/sentinel.json" && printf yes || printf no)" yes
check 'retry releases hold after termination' "$([[ -e "$retry_dir/hold" || -e "$retry_dir/held" ]] && printf no || printf yes)" yes
check 'hold was never removed while anchor was alive' "$([[ -f "$retry_dir/retry-hold-removed-early" ]] && printf no || printf yes)" yes
if saved_identity_alive "$retry_dir/child.json"; then
    pgid=$(jq -r .pgid "$retry_dir/child.json")
    kill -KILL -- "-$pgid" 2>/dev/null || true
    finish "$job" || true
fi

printf '  allocation and publication failures\n'
real_mktemp=$(command -v mktemp)
for stage in brief meta; do
    reset_jobs
    if [[ "$stage" == brief ]]; then
        printf '#!/usr/bin/env bash\n[[ "$1" != */brief.XXXXXX ]] || exit 71\nexec %q "$@"\n' "$real_mktemp" > "$TMP/bin/mktemp"
    else
        printf '#!/usr/bin/env bash\n[[ "$1" != */meta.json.XXXXXX ]] || exit 72\nexec %q "$@"\n' "$real_mktemp" > "$TMP/bin/mktemp"
    fi
    chmod +x "$TMP/bin/mktemp"
    printf 'x\n' | PATH="$TMP/bin:$PATH" w "$W" start sol > "$TMP/allocation-$stage" 2>&1
    check "$stage injection fails start" "$([[ $? -ne 0 ]] && printf yes || printf no)" yes
    check "$stage allocated job" "$(job_count)" 1
    dir=("$TMP"/state/jobs/*)
    check "$stage allocation publishes rc" "$([[ -s "${dir[0]}/rc" ]] && printf yes || printf no)" yes
    check "$stage allocation publishes out" "$([[ -s "${dir[0]}/out" ]] && printf yes || printf no)" yes
done
rm -f "$TMP/bin/mktemp"
reset_jobs
printf '#!/usr/bin/env bash\n[[ "$1" != */session.XXXXXX ]] || exit 73\nexec %q "$@"\n' "$real_mktemp" > "$TMP/bin/mktemp"
chmod +x "$TMP/bin/mktemp"
job=$(printf 'x\n' | PATH="$TMP/bin:$PATH" w "$W" start sol)
finish "$job" || true
check 'EXIT with publication lock publishes rc' "$([[ -s "$TMP/state/jobs/$job/rc" ]] && printf yes || printf no)" yes
check 'EXIT publication error has nonzero rc' "$(< "$TMP/state/jobs/$job/rc")" 73
rm -f "$TMP/bin/mktemp"

printf '  lost, cancellation and identity safety\n'
reset_jobs
mkdir -p "$TMP/state/jobs/1790909617-98765432"
printf '{"id":"1790909617-98765432","tier":"sol","model":"gpt-6-sol@high","started":1790909617,"supervisor":{"pid":99999999,"pgid":99999999,"starttime":"1","boot_id":"x"}}\n' > "$TMP/state/jobs/1790909617-98765432/meta.json"
printf '{"pid":99999999,"pgid":99999999,"starttime":"1","boot_id":"x"}\n' > "$TMP/state/jobs/1790909617-98765432/child.json"
check 'dead child and supervisor lost' "$(json '.[0].state' "$(w "$W" jobs --json --id 1790909617-98765432)")" lost
reset_jobs
job=$(printf 'x\n' | w STUB_SLEEP=300 "$W" start sol)
for ((i=0;i<60;i++)); do [[ -s "$TMP/state/jobs/$job/child.json" && -s "$TMP/stub.pids" ]] && break; sleep 0.05; done
stub=$(cat "$TMP/stub.pids" 2>/dev/null)
w "$W" cancel "$job" >/dev/null; check 'cancel exit' "$?" 0
finish "$job" || true
check 'cancel rc' "$(cat "$TMP/state/jobs/$job/rc" 2>/dev/null)" 130
check 'cancel state' "$(json '.[0].state' "$(w "$W" jobs --json --id "$job")")" cancelled
check 'stub process terminated' "$([[ -n "$stub" && ! -d "/proc/$stub" ]] && printf yes || printf no)" yes
w "$W" cancel "$job" >/dev/null 2>&1; check 'cancel terminal refuses' "$?" 2
reset_jobs
# Log the supervisor's group signals, never the requester's. A delayed TERM
# crosses Claude's natural exit; the anchor must still pin its group id.
kill_hook='() { if [[ ( "${1:-}" == -TERM || "${1:-}" == -KILL ) && "${2:-}" == -- && "${3:-}" == -* ]]; then dir="$CLAUDEX_STATE_DIR/jobs/$CLAUDEX_JOB_ID"; if ! jq -e --slurpfile saved "$dir/child.json" ". == \$saved[0]" "$dir/held" >/dev/null 2>&1; then printf "unheld\n" >> "$dir/signals"; else printf "held\n" >> "$dir/signals"; fi; [[ "$1" != -TERM ]] || sleep 0.8; fi; builtin kill "$@"; }'
job=$(printf 'x\n' | w "BASH_FUNC_kill%%=$kill_hook" STUB_SLEEP=0.4 "$W" start sol)
for ((i=0;i<60;i++)); do [[ -s "$TMP/state/jobs/$job/child.json" && -s "$TMP/stub.pids" ]] && break; sleep 0.05; done
w "$W" cancel "$job" > "$TMP/hold-cancel" 2>&1
finish "$job" || true
check 'supervisor signals only with held acknowledgment' "$([[ -s "$TMP/state/jobs/$job/signals" && "$(< "$TMP/state/jobs/$job/signals")" != *unheld* ]] && printf yes || printf no)" yes
check 'cancel preserves unrelated process after natural exit window' "$(saved_identity_alive "$TMP/sentinel.json" && printf yes || printf no)" yes
reset_jobs
# Both request paths race, but only the supervisor may signal the group. The
# CLI hook records any forbidden group kill; the supervisor hook counts signals.
supervisor_hook='() { if [[ ( "${1:-}" == -TERM || "${1:-}" == -KILL ) && "${2:-}" == -- && "${3:-}" == -* ]]; then printf "%s\n" "$1" >> "$SIGNAL_LOG"; fi; builtin kill "$@"; }'
cli_hook='() { if [[ "${2:-}" == -- && "${3:-}" == -* ]]; then printf "%s\n" "$1" >> "$CLI_KILL_LOG"; sleep 0.2; fi; builtin kill "$@"; }'
job=$(printf 'x\n' | w "BASH_FUNC_kill%%=$supervisor_hook" SIGNAL_LOG="$TMP/group-signals" STUB_SLEEP=300 STUB_IGNORE_TERM=1 "$W" start sol)
for ((i=0;i<100;i++)); do [[ -s "$TMP/state/jobs/$job/child.json" && -s "$TMP/stub.pids" ]] && break; sleep 0.05; done
supervisor=$(jq -r '.supervisor.pid' "$TMP/state/jobs/$job/meta.json")
w "BASH_FUNC_kill%%=$cli_hook" CLI_KILL_LOG="$TMP/cli-signals" "$W" cancel "$job" > "$TMP/concurrent-cancel" 2>&1 & canceller=$!
for ((i=0;i<100;i++)); do [[ -f "$TMP/state/jobs/$job/stop" || -s "$TMP/cli-signals" ]] && break; sleep 0.02; done
kill -TERM "$supervisor" 2>/dev/null || true
wait "$canceller"; check 'concurrent cancel accepts request' "$?" 0
finish "$job" || true
check 'concurrent TERM publishes cancelled rc' "$(< "$TMP/state/jobs/$job/rc")" 130
check 'cancel never signals a group' "$([[ -s "$TMP/cli-signals" ]] && printf no || printf yes)" yes
terms=0 kills=0
if [[ -f "$TMP/group-signals" ]]; then
    while IFS= read -r signal; do
        [[ "$signal" != -TERM ]] || terms=$((terms+1))
        [[ "$signal" != -KILL ]] || kills=$((kills+1))
    done < "$TMP/group-signals"
fi
check 'group receives exactly one TERM' "$terms" 1
check 'group receives exactly one KILL' "$kills" 1
check 'unrelated sentinel survives concurrent termination' "$(saved_identity_alive "$TMP/sentinel.json" && printf yes || printf no)" yes
rm -f "$TMP/group-signals" "$TMP/cli-signals"
reset_jobs
job=$(printf 'x\n' | w STUB_SLEEP=300 STUB_IGNORE_TERM=1 "$W" start sol)
for ((i=0;i<100;i++)); do [[ -s "$TMP/state/jobs/$job/child.json" && -s "$TMP/stub.pids" ]] && break; sleep 0.05; done
w "$W" cancel "$job" > "$TMP/abandoned-cancel" 2>&1 & requester=$!
for ((i=0;i<100;i++)); do [[ -f "$TMP/state/jobs/$job/stop" ]] && break; sleep 0.02; done
check 'abandoned cancel wrote stop' "$([[ -f "$TMP/state/jobs/$job/stop" ]] && printf yes || printf no)" yes
kill -TERM "$requester" 2>/dev/null || true
wait "$requester" 2>/dev/null || true
finish "$job" || true
check 'abandoned cancel still publishes rc' "$(< "$TMP/state/jobs/$job/rc")" 130
check 'abandoned cancel leaves no hold' "$([[ -f "$TMP/state/jobs/$job/hold" ]] && printf no || printf yes)" yes
check 'abandoned cancel releases anchor' "$(saved_identity_alive "$TMP/state/jobs/$job/child.json" && printf no || printf yes)" yes
reset_jobs
job=$(printf 'x\n' | w STUB_SLEEP=300 STUB_IGNORE_TERM=1 "$W" start sol)
for ((i=0;i<60;i++)); do [[ -s "$TMP/state/jobs/$job/child.json" && -s "$TMP/stub.pids" ]] && break; sleep 0.05; done
stub=$(cat "$TMP/stub.pids" 2>/dev/null)
started=$(date +%s)
w "$W" cancel "$job" >/dev/null; check 'TERM-resistant cancel exit' "$?" 0
finish "$job" || true
check 'TERM-resistant cancel rc' "$(cat "$TMP/state/jobs/$job/rc" 2>/dev/null)" 130
check 'TERM-resistant cancel within 7s' "$(( $(date +%s) - started <= 7 ))" 1
check 'TERM-resistant stub killed' "$([[ -n "$stub" && ! -d "/proc/$stub" ]] && printf yes || printf no)" yes
check 'sentinel survives TERM to KILL' "$(saved_identity_alive "$TMP/sentinel.json" && printf yes || printf no)" yes
reset_jobs
job=$(printf 'x\n' | w STUB_SLEEP=300 STUB_SPAWN_CHILD=1 "$W" start sol)
for ((i=0;i<100;i++)); do [[ -s "$TMP/state/jobs/$job/child.json" && -s "$TMP/stub.descendant" ]] && break; sleep 0.05; done
pgid=$(jq -r .pgid "$TMP/state/jobs/$job/child.json" 2>/dev/null)
check 'TERM-resistant descendant really spawned' "$([[ -s "$TMP/stub.descendant" ]] && printf yes || printf no)" yes
check 'descendant starts in job group' "$(group_members "$pgid" && printf yes || printf no)" yes
w "$W" cancel "$job" >/dev/null; check 'descendant cancel exits' "$?" 0
finish "$job" || true
check 'TERM-resistant descendant gone after leader exits' "$(group_members "$pgid" && printf no || printf yes)" yes
check 'sentinel survives descendant cancellation' "$(saved_identity_alive "$TMP/sentinel.json" && printf yes || printf no)" yes
reset_jobs
job=$(printf 'x\n' | w STUB_SLEEP=300 STUB_SPAWN_CHILD=1 "$W" start sol)
for ((i=0;i<100;i++)); do [[ -s "$TMP/state/jobs/$job/child.json" && -s "$TMP/stub.descendant" ]] && break; sleep 0.05; done
pgid=$(jq -r .pgid "$TMP/state/jobs/$job/child.json" 2>/dev/null)
supervisor=$(jq -r '.supervisor.pid // empty' "$TMP/state/jobs/$job/meta.json" 2>/dev/null)
[[ "$supervisor" =~ ^[0-9]+$ ]] && kill -TERM "$supervisor" 2>/dev/null || true
finish "$job" || true
check 'supervisor TERM publishes rc' "$([[ -f "$TMP/state/jobs/$job/rc" ]] && printf yes || printf no)" yes
check 'supervisor TERM rc' "$(< "$TMP/state/jobs/$job/rc")" 143
check 'supervisor TERM kills whole group' "$(group_members "$pgid" && printf no || printf yes)" yes
reset_jobs
for scenario in starttime boot pgid malformed; do
    dir="$TMP/state/jobs/1790909617-1234567${#scenario}"
    mkdir -p "$dir"
    identity "$sentinel" "$sentinel" > "$dir/child.json"
    identity "$sentinel" "$sentinel" | jq '{pid,pgid,starttime,boot_id}' > "$dir/meta.json"
    jq '.supervisor={pid:99999999,pgid:99999999,starttime:"1",boot_id:"x"} | .started=1790909617' "$dir/meta.json" > "$dir/meta.tmp" && mv "$dir/meta.tmp" "$dir/meta.json"
    case "$scenario" in
        starttime) jq '.starttime="0"' "$dir/child.json" > "$dir/temp" && mv "$dir/temp" "$dir/child.json" ;;
        boot) jq '.boot_id="wrong"' "$dir/child.json" > "$dir/temp" && mv "$dir/temp" "$dir/child.json" ;;
        pgid) jq '.pgid=1' "$dir/child.json" > "$dir/temp" && mv "$dir/temp" "$dir/child.json" ;;
        malformed) printf '{broken' > "$dir/child.json" ;;
    esac
    w "$W" cancel "${dir##*/}" >/dev/null 2>&1; check "cancel $scenario refuses" "$?" 2
    check "sentinel survives $scenario" "$(kill -0 "$sentinel" 2>/dev/null && printf yes || printf no)" yes
done
# Change the identity file precisely when the old canceller re-reads its numeric PGID.
reset_jobs
job=$(printf 'x\n' | w STUB_SLEEP=300 STUB_IGNORE_TERM=1 "$W" start sol)
for ((i=0;i<100;i++)); do [[ -s "$TMP/state/jobs/$job/child.json" ]] && break; sleep 0.05; done
cp "$TMP/state/jobs/$job/child.json" "$TMP/original-child.json"
printf '#!/usr/bin/env bash\nif [[ "${2:-}" == .pgid && "${3:-}" == */child.json ]]; then cp "$IDENTITY_REPLACEMENT" "$3"; : > "$IDENTITY_SWAPPED"; fi\nexec %q "$@"\n' "$real_jq" > "$TMP/bin/jq"
chmod +x "$TMP/bin/jq"
PATH="$TMP/bin:$PATH" w IDENTITY_REPLACEMENT="$TMP/sentinel.json" IDENTITY_SWAPPED="$TMP/identity-swapped" "$W" cancel "$job" >/dev/null 2>&1 || true
check 'cancel never rereads identity to select signal target' "$([[ -f "$TMP/identity-swapped" ]] && printf no || printf yes)" yes
check 'identity swap does not signal unrelated group' "$(saved_identity_alive "$TMP/sentinel.json" && printf yes || printf no)" yes
rm -f "$TMP/bin/jq"
if saved_identity_alive "$TMP/original-child.json"; then
    kill -KILL -- "-$(jq -r .pgid "$TMP/original-child.json")" 2>/dev/null || true
fi
if saved_identity_alive "$TMP/sentinel.json"; then kill -- "-$sentinel" 2>/dev/null || true; fi
wait "$sentinel" 2>/dev/null || true; sentinel=

printf '  cancel/completion races\n'
reset_jobs
for ((i=0;i<20;i++)); do
    job=$(printf 'x\n' | w STUB_SLEEP=1 "$W" start luna)
    sleep 0.9
    w "$W" cancel "$job" >/dev/null 2>&1 || true
    finish "$job" || true
    check "race $i publishes rc" "$([[ -f "$TMP/state/jobs/$job/rc" ]] && printf yes || printf no)" yes
    state=$(json '.[0].state' "$(w "$W" jobs --json --id "$job")")
    rc=$(cat "$TMP/state/jobs/$job/rc" 2>/dev/null)
    check "race $i state agrees with rc" "$state" "$([[ "$rc" == 130 && -f "$TMP/state/jobs/$job/cancelled" ]] && printf cancelled || printf done)"
done

printf '  listing, status, log parsing\n'
reset_jobs
for ((i=0;i<25;i++)); do printf 'x\n' | w "$W" run luna >/dev/null; done
all=$(w "$W" jobs --json)
check 'default limit' "$(json length "$all")" 20
newest=$(printf 'x\n' | w "$W" start luna); finish "$newest" || true
check 'newest job first' "$(json '.[0].id' "$(w "$W" jobs --json)")" "$newest"
ids=(); for d in "$TMP"/state/jobs/*; do ids+=("${d##*/}"); done
selected=$(w "$W" jobs --json --id "${ids[0]}" --id "${ids[1]}")
check 'two exact ids' "$(json length "$selected")" 2
check 'first selected id' "$(json '.[0].id' "$selected")" "${ids[0]}"
missing=$(w "$W" jobs --json --id 1790909617-deadbeef)
check 'unknown id missing' "$(json '.[0].state' "$missing")" missing
check 'missing record normalized' "$(json '.[0] | keys == ["cwd","elapsed_s","findings_error","has_findings","id","kind","legacy","mode","model","origin","owner","rc","session","started","state","tier"]' "$missing")" true
reset_jobs
owned=$(printf 'x\n' | w CLAUDEX_JOB_ORIGIN=mod CLAUDEX_JOB_OWNER=owner-abc "$W" start luna); finish "$owned" || true
for ((i=0;i<25;i++)); do printf 'x\n' | w "$W" run luna >/dev/null; done
owned_list=$(w "$W" jobs --json --owner owner-abc)
check 'owner query finds older job' "$(json '.[0].id' "$owned_list")" "$owned"
check 'owner query excludes newer jobs' "$(json length "$owned_list")" 1
check 'owner query has normalized fields' "$(json '.[0] | keys == ["cwd","elapsed_s","findings_error","has_findings","id","kind","legacy","mode","model","origin","owner","rc","session","started","state","tier"]' "$owned_list")" true
printf 'CLAUDEX_DELEGATION=suggest\n' > "$TMP/config"
status=$(w CLAUDEX_DELEGATION=auto "$W" status --json)
check 'status parses JSON' "$(json 'type' "$status")" object
check 'eight policy keys' "$(json '.policy | length' "$status")" 8
check 'eight sources' "$(json '.policy_sources | length' "$status")" 8
check 'env wins file' "$(json '.policy.CLAUDEX_DELEGATION' "$status")" auto
check 'env source' "$(json '.policy_sources.CLAUDEX_DELEGATION' "$status")" env
check 'file source' "$(json '.policy_sources.CLAUDEX_DELEGATION' "$(w "$W" status --json)")" file
check 'default source' "$(json '.policy_sources.CLAUDEX_TIERS' "$status")" default
check 'plan initially null' "$(json '.plan' "$status")" null
old=$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ)
printf '%s id=1 model=gpt-6-sol effort=high stream=0 status=200 upstream=200 ms=3 in=1 out=2 cached=0 used_pct=84.5 limit=5h\n' "$old" > "$TMP/state/proxy.log"
plan=$(w "$W" status --json)
check 'plan percentage' "$(json '.plan.used_pct' "$plan")" 84.5
check 'plan limit' "$(json '.plan.limit' "$plan")" 5h
check 'plan age grows' "$(json '.plan.age_s >= 7100' "$plan")" true
printf '%s id=2 used_pct=- limit=weekly\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$TMP/state/proxy.log"
check 'dash ignored' "$(json '.plan.used_pct' "$(w "$W" status --json)")" 84.5

printf '  structured adversary findings\n'
reset_jobs
finding='{"id":"F1","severity":"high","title":"Bug","mechanism":"route","evidence":"line 1","fix":"patch","unverified":false}'
block=$(printf '\n```claudex-findings\n[%s]\n```\n' "$finding")
job=$(printf 'review\n' | w STUB_FINDINGS="$block" "$W" start adversary); finish "$job" || true
prompt=$(< "$TMP/stub.log"); prompt=${prompt#*'[--append-system-prompt] ['}; prompt=${prompt%%']'*}
contains 'adversary prompt requests findings fence' "$prompt" 'claudex-findings'
contains 'adversary prompt includes bounded schema' "$prompt" 'unverified'
contains 'adversary prompt includes item bound' "$prompt" 'at most 50'
contains 'adversary prompt includes size bound' "$prompt" '256 KiB'
check 'valid findings stored' "$(jq -c . "$TMP/state/jobs/$job/findings.json" 2>/dev/null)" "[$finding]"
check 'findings command' "$(w "$W" findings "$job" 2>/dev/null | jq -c .)" "[$finding]"
check 'has findings flag' "$(json '.[0].has_findings' "$(w "$W" jobs --json --id "$job")")" true
reset_jobs
job=$(printf 'review\n' | w STUB_FINDINGS="$(printf '\n```claudex-findings\n[broken]\n```%s' "$block")" "$W" start adversary); finish "$job" || true
check 'last block wins' "$(jq -c . "$TMP/state/jobs/$job/findings.json" 2>/dev/null)" "[$finding]"
for scenario in truncated invalid; do
    reset_jobs
    case "$scenario" in
        truncated) last=$'\n```claudex-findings\n[unfinished' ;;
        invalid) last=$'\n```claudex-findings\n[broken]\n```' ;;
    esac
    printf '%s%s' "$block" "$last" > "$TMP/findings-block"
    job=$(printf 'review\n' | w STUB_FINDINGS_FILE="$TMP/findings-block" "$W" start adversary)
    finish "$job" || true
    check "$scenario final fence rejects earlier valid findings" "$([[ -f "$TMP/state/jobs/$job/findings.json" ]] && printf no || printf yes)" yes
    check "$scenario final fence reports error" "$(json '.[0].findings_error != null and (.[0].findings_error | length) > 0' "$(w "$W" jobs --json --id "$job")")" true
done
for scenario in malformed missing severity title mechanism evidence fix items duplicate stream longid oversized; do
    reset_jobs
    case "$scenario" in
        malformed) content='oops' ;;
        missing) content="[$(jq -cn --argjson f "$finding" '$f | del(.fix)')]" ;;
        severity) content="[$(jq -cn --argjson f "$finding" '$f | .severity="urgent"')]" ;;
        title) content="[$(jq -cn --argjson f "$finding" '$f | .title=("x"*201)')]" ;;
        mechanism|evidence|fix) content="[$(jq -cn --argjson f "$finding" --arg key "$scenario" '$f | .[$key] = ("x"*2001)')]" ;;
        items) content=$(jq -cn --argjson f "$finding" '[range(51) | . as $n | $f | .id="F\($n + 1)"]') ;;
        duplicate) content="[$finding,$finding]" ;;
        stream) content=$'[]\n[]' ;;
        longid) content="[$(jq -cn --argjson f "$finding" '$f | .id="F12345678901234567"')]" ;;
        oversized) content=$(jq -cn --argjson f "$finding" '[range(50) | . as $n | $f | .id="F\($n + 1)" | .mechanism=("m"*2000) | .evidence=("e"*2000) | .fix=("f"*2000)]') ;;
    esac
    printf '\n```claudex-findings\n%s\n```' "$content" > "$TMP/findings-block"
    job=$(printf 'review\n' | w STUB_FINDINGS_FILE="$TMP/findings-block" "$W" start adversary)
    finish "$job" || true
    check "$scenario findings rejected" "$([[ -f "$TMP/state/jobs/$job/findings.json" ]] && printf no || printf yes)" yes
    check "$scenario error populated" "$(json '.[0].findings_error != null and (.[0].findings_error | length) > 0' "$(w "$W" jobs --json --id "$job")")" true
    check "$scenario report retained" "$(cat "$TMP/state/jobs/$job/out" 2>/dev/null)" "$(w "$W" result "$job" 2>/dev/null)"
    w "$W" findings "$job" >/dev/null 2>&1; check "$scenario command absent" "$?" 1
done
reset_jobs
job=$(printf 'review\n' | w STUB_FINDINGS=$'\n```claudex-findings\n[]\n```' "$W" start adversary); finish "$job" || true
check 'empty findings valid' "$(jq -c . "$TMP/state/jobs/$job/findings.json" 2>/dev/null)" '[]'
reset_jobs
extra="[$(jq -cn --argjson f "$finding" '$f | .extra="omit me"')]"
job=$(printf 'review\n' | w STUB_FINDINGS="$(printf '\n```claudex-findings\n%s\n```' "$extra")" "$W" start adversary); finish "$job" || true
check 'extra properties stripped' "$(jq -c . "$TMP/state/jobs/$job/findings.json" 2>/dev/null)" "[$finding]"
reset_jobs
job=$(printf 'review\n' | w "$W" start adversary --resume 11111111-1111-1111-1111-111111111111); finish "$job" || true
prompt=$(< "$TMP/stub.log"); prompt=${prompt#*'[--append-system-prompt] ['}; prompt=${prompt%%']'*}
contains 'resumed adversary prompt includes findings contract' "$prompt" 'claudex-findings'

printf '  resume, permissions, pruning and legacy ids\n'
reset_jobs
uuid=22222222-2222-2222-2222-222222222222
printf 'x\n' | w "$W" run sol --resume "$uuid" >/dev/null
contains 'run resume flag' "$(< "$TMP/stub.log")" "[--resume] [$uuid]"
reset_jobs
job=$(printf 'x\n' | w "$W" start sol --resume "$uuid"); finish "$job" || true
contains 'start resume flag' "$(< "$TMP/stub.log")" "[--resume] [$uuid]"
reset_jobs
printf 'x\n' | w "$W" resume "$uuid" sol >/dev/null
contains 'resume alias flag' "$(< "$TMP/stub.log")" "[--resume] [$uuid]"
check 'jobs mode' "$(stat -c %a "$TMP/state/jobs")" 700
for d in "$TMP"/state/jobs/*; do check 'job dir mode' "$(stat -c %a "$d")" 700; done
chmod 755 "$TMP/state/jobs"
printf 'x\n' | w "$W" run sol >/dev/null
check 'permissive jobs dir fixed' "$(stat -c %a "$TMP/state/jobs")" 700
reset_jobs
mkdir -p "$TMP/state/jobs/$(date +%s)-00000000"
printf '%s\n' '#!/usr/bin/env bash' \
    'counter="$(dirname "$0")/collision-count"' \
    'if [[ -e "$counter" ]]; then printf " 11 11 11 11\\n"; else : > "$counter"; printf " 00 00 00 00\\n"; fi' > "$TMP/bin/od"
chmod +x "$TMP/bin/od"
job=$(printf 'x\n' | PATH="$TMP/bin:$PATH" w "$W" start luna)
finish "$job" || true
check 'id collision retried' "${job#*-}" 11111111
rm -f "$TMP/bin/od" "$TMP/bin/collision-count"
reset_jobs
mkdir -p "$TMP/state/jobs" "$TMP/symlink-target"
ln -s "$TMP/symlink-target" "$TMP/state/jobs/1790909617-deadbeef"
w "$W" jobs --json --id 1790909617-deadbeef >/dev/null 2>"$TMP/link-error"; check 'symlink job refused' "$?" 2
contains 'symlink error message' "$(< "$TMP/link-error")" 'symlink'
reset_jobs
for id in 1790909617-12345678 1790909617-23456789 1790909617-34567890; do mkdir -p "$TMP/state/jobs/$id"; done
printf 0 > "$TMP/state/jobs/1790909617-12345678/rc"
printf 0 > "$TMP/state/jobs/1790909617-23456789/rc"
touch -d '8 days ago' "$TMP/state/jobs/1790909617-12345678/rc" "$TMP/state/jobs/1790909617-34567890"
touch -d '1 day ago' "$TMP/state/jobs/1790909617-23456789/rc"
printf 'x\n' | w "$W" run luna >/dev/null
check 'old completed job pruned' "$([[ -e "$TMP/state/jobs/1790909617-12345678" ]] && printf no || printf yes)" yes
check 'recent job kept' "$([[ -d "$TMP/state/jobs/1790909617-23456789" ]] && printf yes || printf no)" yes
check 'old unfinished job kept' "$([[ -d "$TMP/state/jobs/1790909617-34567890" ]] && printf yes || printf no)" yes
mkdir -p "$TMP/state/jobs/1790909617-7892"
printf 0 > "$TMP/state/jobs/1790909617-7892/rc"
printf 'legacy result\n' > "$TMP/state/jobs/1790909617-7892/out"
w "$W" wait 1790909617-7892 --timeout 0 >/dev/null; check 'legacy wait' "$?" 0
check 'legacy result' "$(w "$W" result 1790909617-7892)" 'legacy result'
legacy=$(w "$W" jobs --json --id 1790909617-7892)
check 'legacy complete JSON shape' "$(json '.[0] | keys == ["cwd","elapsed_s","findings_error","has_findings","id","kind","legacy","mode","model","origin","owner","rc","session","started","state","tier"]' "$legacy")" true
check 'legacy flag' "$(json '.[0].legacy' "$legacy")" true
check 'legacy completed state' "$(json '.[0].state' "$legacy")" done
check 'legacy unknowns are null' "$(json '.[0] | [.tier,.kind,.model,.mode,.cwd,.origin,.owner,.started,.session,.findings_error] | all(. == null)' "$legacy")" true

printf '  Makefile plugin checks and temporary import maps\n'
mkdir -p "$TMP/make-bin"
printf 'declare module "claude-code" {}\n' > "$TMP/types.d.ts"
printf '%s\n' '#!/usr/bin/env bash' \
    'if [[ "$1 $2" == "plugin validate" ]]; then exit 0; fi' \
    'if [[ "$1 $2" == "plugin test" && "${CLAUDE_REFUSE:-}" == 1 ]]; then printf "hooks modules are turned off in this process\n" >&2; exit 1; fi' \
    'exit 0' > "$TMP/make-bin/claude"
printf '%s\n' '#!/usr/bin/env bash' \
    '[[ "$1" == check ]] || exit 1' \
    'while (($#)); do if [[ "$1" == --import-map ]]; then printf "%s\n" "$2" > "$DENO_MAP_LOG"; [[ -f "$2" ]] || exit 2; break; fi; shift; done' > "$TMP/make-bin/deno"
printf '%s\n' '#!/bin/bash' \
    '[[ "${1:-}" != tests/worker/mod_footprint_test.sh ]] || exit 0' \
    'exec /usr/bin/bash "$@"' > "$TMP/make-bin/bash"
printf '%s\n' '#!/bin/bash' \
    'if [[ "${1:-}" == /tmp/claudex-mod-imports.* && ! -w /tmp ]]; then printf "%s\n" "$1" > "$MKTEMP_TEMPLATE"; exec /usr/bin/mktemp "$MKTEMP_FALLBACK_DIR/claudex-mod-imports.XXXXXX.json"; fi' \
    'exec /usr/bin/mktemp "$@"' > "$TMP/make-bin/mktemp"
chmod +x "$TMP/make-bin/claude" "$TMP/make-bin/deno" "$TMP/make-bin/bash" "$TMP/make-bin/mktemp"
# On read-only /tmp, record the unset-TMPDIR template and redirect the real
# temporary map into the repository cache. With writable /tmp, check its path directly.
make_env=(PATH="$TMP/make-bin:$PATH" MOD_TYPES="$TMP/types.d.ts" DENO_MAP_LOG="$TMP/deno-map" MKTEMP_TEMPLATE="$TMP/mktemp-template" MKTEMP_FALLBACK_DIR="$ROOT/.cache")
make_out=$(env -u TMPDIR "${make_env[@]}" CLAUDE_REFUSE=1 make -s -C "$ROOT" plugin-check 2>&1)
check 'rollout refusal skips plugin tests' "$?" 0
[[ "$make_out" != *'make: ***'* ]] || printf '    rollout make output: %s\n' "$make_out"
contains 'rollout refusal prints UNVERIFIED' "$make_out" 'UNVERIFIED: plugin tests skipped (Claude Code hooks modules are switched off for this account/process)'
check 'rollout refusal continues to type check' "$([[ -s "$TMP/deno-map" ]] && printf yes || printf no)" yes
make_out=$(env -u TMPDIR "${make_env[@]}" make -s -C "$ROOT" plugin-check 2>&1)
check 'unset TMPDIR type check exit' "$?" 0
[[ "$make_out" != *'make: ***'* ]] || printf '    type-check make output: %s\n' "$make_out"
if [[ -w /tmp ]]; then
    contains 'unset TMPDIR map created under /tmp' "$(< "$TMP/deno-map")" '/tmp/claudex-mod-imports.'
else
    contains 'unset TMPDIR requests map under /tmp' "$(< "$TMP/mktemp-template")" '/tmp/claudex-mod-imports.'
fi
make_out=$(env "${make_env[@]}" TMPDIR="$ROOT/.cache" make -s -C "$ROOT" plugin-check 2>&1)
check 'repository-cache TMPDIR type check exit' "$?" 0
contains 'repository-cache type map created' "$(< "$TMP/deno-map")" "$ROOT/.cache/claudex-mod-imports."

printf '  %s checks, %s failures\n' "$checks" "$fails"
exit $((fails > 0))
