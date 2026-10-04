#!/usr/bin/env bash
# Exercises step and admit with an isolated stub proxy and no real credentials.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
W="$ROOT/plugin/bin/claudex-worker"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/claudex-step-XXXXXX")" || { printf '    FAIL: cannot create step test directory\n' >&2; exit 1; }
[[ -d "$TMP" ]] || { printf '    FAIL: step test directory is missing\n' >&2; exit 1; }
fails=0 checks=0
check() { checks=$((checks+1)); if [[ "$2" != "$3" ]]; then fails=$((fails+1)); printf '    FAIL: %s: got %q, want %q\n' "$1" "$2" "$3"; fi; }
contains() { checks=$((checks+1)); case "$2" in *"$3"*) ;; *) fails=$((fails+1)); printf '    FAIL: %s: %q not in %q\n' "$1" "$3" "${2:0:400}";; esac; }
cleanup() {
    if [[ -n "${job:-}" ]]; then w "$W" cancel "$job" >/dev/null 2>&1 || true; fi
    [[ -z "${step_pid:-}" ]] || { kill "$step_pid" 2>/dev/null || true; wait "$step_pid" 2>/dev/null || true; }
    [[ -z "${PROXY_PID:-}" ]] || { kill "$PROXY_PID" 2>/dev/null || true; wait "$PROXY_PID" 2>/dev/null || true; }
    rm -rf -- "$TMP"
}
trap cleanup EXIT
mkdir -p "$TMP/state" "$TMP/bin"
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
printf '%s' step-test-nonce > "$TMP/state/instance"
chmod 600 "$TMP/state/instance"
printf '%s\n' '#!/usr/bin/env bash' '[[ ! -f "$HOME/sleep" ]] || exec sleep 5' > "$TMP/bin/claude"
chmod +x "$TMP/bin/claude"
cat > "$TMP/fixture.sse" <<'EOF'
event: message_start
data: {"type":"message_start","message":{"id":"m1"}}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"text":"hello"}}

event: message_stop
data: {"type":"message_stop"}

EOF
cat > "$TMP/proxy.py" <<'PY'
import json
import pathlib
import socket
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

root = pathlib.Path(sys.argv[2])

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path != '/healthz':
            self.send_error(404)
            return
        body = b'{"service":"claudex-proxy","instance":"step-test-nonce"}'
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != '/v1/messages':
            self.send_error(404)
            return
        body = self.rfile.read(int(self.headers['Content-Length']))
        with (root / 'requests').open('ab') as log:
            log.write(body.rstrip(b'\n') + b'\n')
        if (root / 'hold').exists():
            (root / 'holding').touch()
            while not (root / 'release').exists():
                time.sleep(0.05)
        if (root / 'disconnect').exists():
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return
        if (root / 'reject').exists():
            code, body, content_type = 400, b'{"error":"stub rejected"}', 'application/json'
        else:
            code, body, content_type = 200, (root / 'fixture.sse').read_bytes(), 'text/event-stream'
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), Handler).serve_forever()
PY
python3 "$TMP/proxy.py" "$PORT" "$TMP" > "$TMP/proxy.log" 2>&1 & PROXY_PID=$!
for ((i=0; i<50; i++)); do
    curl -fsS -m 1 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
    sleep 0.1
done
if ! curl -fsS -m 1 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    printf '    FAIL: stub proxy did not start\n' >&2
    exit 1
fi
w() {
    env -i HOME="$TMP" PATH="$PATH" CLAUDEX_CONFIG_FILE="$TMP/config" CLAUDEX_STATE_DIR="$TMP/state" \
        CLAUDEX_PORT="$PORT" CLAUDEX_PROXY_BIN=/bin/true CLAUDEX_CLAUDE_BIN="$TMP/bin/claude" "$@"
}
request='{"messages":[{"role":"user","content":"hi"}],"max_tokens":42,"model":"original","stream":false}'
expected=$'{"type":"message_start","message":{"id":"m1"}}\n{"type":"content_block_delta","delta":{"text":"hello"}}\n{"type":"message_stop"}'
request_count() { if [[ -f "$TMP/requests" ]]; then wc -l < "$TMP/requests" | tr -d ' '; else printf '0'; fi; }

printf '  step streams fixture events and changes only model and stream\n'
expected_count=0
for variant in 'sol gpt-sol' 'sol:xhigh gpt-sol@xhigh' 'terra gpt-sol'; do
    tier=${variant%% *} model=${variant#* }
    args=("${tier%%:*}")
    [[ "$tier" != *:* ]] || args+=(--effort "${tier#*:}")
    out=$(printf '%s\n' "$request" | w "$W" step "${args[@]}" 2> "$TMP/err"); rc=$?
    check "step $tier exit" "$rc" 0
    check "step $tier NDJSON lines" "$out" "$expected"
    expected_count=$((expected_count+1))
    check "step $tier request logged" "$(request_count)" "$expected_count"
    last=$(python3 - "$TMP/requests" <<'PY'
import json, sys
with open(sys.argv[1]) as log:
    print(json.dumps(json.loads(log.readlines()[-1]), sort_keys=True, separators=(',', ':')))
PY
)
    check "step $tier request" "$last" "$(jq -cS --arg model "$model" '.model=$model | .stream=true' <<< "$request")"
done
check 'three requests reached proxy' "$(request_count)" 3

printf '  step refuses policy failures before sending a request\n'
start_error=$(printf 'brief\n' | w CLAUDEX=off "$W" start sol 2>&1); start_rc=$?
step_error=$(printf '%s\n' "$request" | w CLAUDEX=off "$W" step sol 2>&1); step_rc=$?
check 'disabled switch exit matches start' "$step_rc" "$start_rc"
check 'disabled switch message matches start' "$step_error" "$start_error"
start_error=$(printf 'brief\n' | w CLAUDEX_TIERS=luna "$W" start sol 2>&1); start_rc=$?
step_error=$(printf '%s\n' "$request" | w CLAUDEX_TIERS=luna "$W" step sol 2>&1); step_rc=$?
check 'disabled tier exit matches start' "$step_rc" "$start_rc"
check 'disabled tier message matches start' "$step_error" "$start_error"
check 'no denied request sent' "$(request_count)" 3

printf '  step reports HTTP and input errors\n'
: > "$TMP/reject"
out=$(printf '%s\n' "$request" | w "$W" step sol 2> "$TMP/err"); rc=$?
check 'HTTP 400 exit' "$rc" 7
check 'HTTP error not sent to stdout' "$out" ''
contains 'HTTP response on stderr' "$(< "$TMP/err")" 'stub rejected'
rm "$TMP/reject"
: > "$TMP/disconnect"
out=$(printf '%s\n' "$request" | w "$W" step sol 2> "$TMP/err"); rc=$?
check 'curl failure exit' "$rc" 7
check 'curl failure not sent to stdout' "$out" ''
contains 'curl failure on stderr' "$(< "$TMP/err")" 'curl:'
rm "$TMP/disconnect"
for invalid in '' 'null' '[]' '"text"' '{bad'; do
    out=$(printf '%s' "$invalid" | w "$W" step sol 2>&1); rc=$?
    check "invalid JSON object ${invalid:-empty} exit" "$rc" 2
done
python3 -c 'import sys; sys.stdout.buffer.write(b" " * (32 * 1024 * 1024 + 1))' > "$TMP/large.json"
out=$(w "$W" step sol < "$TMP/large.json" 2>&1); rc=$?
check 'over 32 MiB exit' "$rc" 2
contains 'over 32 MiB message' "$out" 'request too large'
check 'invalid input never reaches proxy' "$(request_count)" 5
check 'step creates no job registry' "$([[ -d "$TMP/state/jobs" ]] && printf yes || printf no)" no

printf '  TERM cleans up a step while the proxy holds its response open\n'
: > "$TMP/hold"
printf '%s\n' "$request" > "$TMP/held-request.json"
env -i HOME="$TMP" PATH="$PATH" CLAUDEX_CONFIG_FILE="$TMP/config" CLAUDEX_STATE_DIR="$TMP/state" \
    CLAUDEX_PORT="$PORT" CLAUDEX_PROXY_BIN=/bin/true CLAUDEX_CLAUDE_BIN="$TMP/bin/claude" \
    "$W" step sol < "$TMP/held-request.json" > "$TMP/held.out" 2> "$TMP/held.err" & step_pid=$!
for ((i=0; i<50; i++)); do [[ -f "$TMP/holding" ]] && break; sleep 0.1; done
check 'proxy is holding the step response' "$([[ -f "$TMP/holding" ]] && printf yes || printf no)" yes
check 'held step allocated both files' "$([[ -n "$(compgen -G "$TMP/state/.step-input.*")" && -n "$(compgen -G "$TMP/state/.step-request.*")" ]] && printf yes || printf no)" yes
( sleep 5; kill -KILL "$step_pid" 2>/dev/null || true ) & watchdog=$!
kill -TERM "$step_pid" 2>/dev/null || true
wait "$step_pid" 2>/dev/null; rc=$?
kill "$watchdog" 2>/dev/null || true
wait "$watchdog" 2>/dev/null || true
step_pid=''
check 'TERM step exit' "$rc" 143
check 'TERM removes step input' "$(compgen -G "$TMP/state/.step-input.*" || true)" ''
check 'TERM removes step request' "$(compgen -G "$TMP/state/.step-request.*" || true)" ''
: > "$TMP/release"

printf '  admit combines agent count with running worker jobs\n'
out=$(w "$W" admit sol --running 0 2>&1); check 'admit zero exit' "$?" 0
check 'admit success is silent' "$out" ''
out=$(w "$W" admit sol --running 3 2>&1); check 'admit three exit without jobs' "$?" 0
out=$(w "$W" admit sol --running 4 2>&1); check 'admit max exit' "$?" 4
contains 'admit max message' "$out" 'claudex: 4 GPT agents/workers already running (CLAUDEX_MAX_PARALLEL=4)'
out=$(w "$W" admit sol --running x 2>&1); check 'invalid running exit' "$?" 2
out=$(w "$W" admit sol --running -1 2>&1); check 'negative running exit' "$?" 2
out=$(w "$W" admit sol --running 999999999999999999999 2>&1); check 'large running count exit' "$?" 4
out=$(w CLAUDEX=off "$W" admit sol --running 0 2>&1); check 'admit disabled switch exit' "$?" 3
contains 'admit disabled switch message' "$out" 'claudex is disabled'
out=$(w CLAUDEX_TIERS=luna "$W" admit sol --running 0 2>&1); check 'admit disabled tier exit' "$?" 4
: > "$TMP/sleep"
job=$(printf 'brief\n' | w "$W" start sol)
check 'running worker started' "$([[ "$job" =~ ^[0-9]+-[0-9a-f]{8}$ ]] && printf yes || printf no)" yes
out=$(w "$W" admit sol --running 3 2>&1); check 'admit counts running worker' "$?" 4
contains 'admit running job message' "$out" 'claudex: 4 GPT agents/workers already running (CLAUDEX_MAX_PARALLEL=4)'
w "$W" cancel "$job" >/dev/null 2>&1 || true
job=''
out=$(w "$W" admit sol --running 3 2>&1); check 'finished worker is not counted' "$?" 0

printf '  %s checks, %s failures\n' "$checks" "$fails"
exit $((fails > 0))
