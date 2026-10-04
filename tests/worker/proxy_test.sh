#!/usr/bin/env bash
# Tests claudex-worker's proxy management against a REAL (sanitized) proxy process and a
# fake upstream. Still no real credentials and no network.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
W="$ROOT/plugin/bin/claudex-worker"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/claudex-pt-XXXXXX")" || { printf '    FAIL: cannot create proxy test directory\n' >&2; exit 1; }
[[ -n "$TMP" && -d "$TMP" ]] || { printf '    FAIL: proxy test directory is missing\n' >&2; exit 1; }
fails=0 checks=0
fail_setup() { printf '    FAIL: %s\n' "$*" >&2; exit 1; }
check()    { checks=$((checks+1)); if [ "$2" = "$3" ]; then :; else fails=$((fails+1)); echo "    FAIL: $1: got '$2', want '$3'"; fi; }
contains() { checks=$((checks+1)); case "$2" in *"$3"*) ;; *) fails=$((fails+1)); echo "    FAIL: $1: '$3' not in: ${2:0:400}";; esac; }

free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
child_is_running() {
    local pid=$1 child running
    [[ -n "$pid" ]] || return 1
    running=$(jobs -pr)
    while IFS= read -r child; do
        [[ "$child" != "$pid" ]] || return 0
    done <<< "$running"
    return 1
}
signal_child() {
    child_is_running "$1" || return 1
    kill "$1" 2>/dev/null
}
cleanup_children() {
    local pid
    # Signal every owned live child before waiting for any of them.
    for pid in "$@"; do signal_child "$pid" || true; done
    for pid in "$@"; do [[ -z "$pid" ]] || wait "$pid" 2>/dev/null || true; done
}
cleanup() {
    # The worker verifies its nonce before stopping an on-demand proxy it launched.
    cleanup_children "${CLEANUP_PID1:-}" "${CLEANUP_PID2:-}" "${UP_PID:-}" "${SQUAT_PID:-}" "${SVC1:-}" "${SVC2:-}" "${SVC3:-}" "${MODEL_PROXY_PID:-}" "${MODEL_BACKEND_PID:-}"
    if [[ -n "${PORT:-}" ]] && declare -F w >/dev/null; then w "$W" stop-proxy >/dev/null 2>&1 || true; fi
    rm -rf "$TMP"
}
trap cleanup EXIT
printf '  cleanup stops multiple live children and skips an exited child\n'
sleep 30 & CLEANUP_PID1=$!
sleep 30 & CLEANUP_PID2=$!
check 'first cleanup child is live' "$(child_is_running "$CLEANUP_PID1" && printf yes || printf no)" yes
check 'second cleanup child is live' "$(child_is_running "$CLEANUP_PID2" && printf yes || printf no)" yes
cleanup_started=$SECONDS
cleanup_children "$CLEANUP_PID1" "$CLEANUP_PID2"
check 'multiple-child cleanup returns promptly' "$((SECONDS - cleanup_started < 5))" 1
check 'first cleanup child ended' "$(child_is_running "$CLEANUP_PID1" && printf yes || printf no)" no
check 'second cleanup child ended' "$(child_is_running "$CLEANUP_PID2" && printf yes || printf no)" no
CLEANUP_PID1= CLEANUP_PID2=
/bin/bash -c 'exit 0' & exited_pid=$!
wait "$exited_pid"
signal_child "$exited_pid"; rc=$?
check 'teardown skips an already exited child' "$rc" 1
UP_PORT=$(free_port) || fail_setup "cannot select upstream port"
PORT=$(free_port) || fail_setup "cannot select proxy port"
[[ -n "$UP_PORT" && -n "$PORT" && "$UP_PORT" != "$PORT" ]] || fail_setup "ports are unavailable or overlap"

mkdir -p "$TMP/bin" "$TMP/state" "$TMP/.codex" "$TMP/upstate" || fail_setup "cannot prepare proxy test files"
printf '{"tokens":{"access_token":"FAKE","account_id":"acct"}}' > "$TMP/.codex/auth.json"
echo text > "$TMP/upstate/mode"
python3 "$ROOT/tests/fake_upstream/server.py" "$UP_PORT" "$TMP/upstate" & UP_PID=$!

# Stub claude that really calls the proxy it was pointed at, so the whole path is exercised.
cat > "$TMP/bin/claude" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
text=$(curl -sS -m 10 -H 'content-type: application/json' -H "authorization: Bearer $ANTHROPIC_AUTH_TOKEN" \
    --data '{"model":"gpt-6-luna","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}' \
    "$ANTHROPIC_BASE_URL/v1/messages" | jq -r '.content[0].text // "NO TEXT"')
jq -n --arg t "$text" '{type:"result",is_error:false,result:("via proxy: "+$t),session_id:"22222222-2222-2222-2222-222222222222",num_turns:1}'
EOF
chmod +x "$TMP/bin/claude"
cat > "$TMP/bin/codex" <<'EOF'
#!/usr/bin/env bash
printf 'codex-cli 0.161.0\n'
EOF
chmod +x "$TMP/bin/codex"
cat > "$TMP/bin/proxy" <<EOF
#!/usr/bin/env bash
printf '%s\\n' "\${CLAUDEX_CODEX_VERSION:-missing}" >> "$TMP/versions"
exec "$ROOT/build/claudex-proxy-test" "\$@"
EOF
chmod +x "$TMP/bin/proxy"

w() {
    env -i HOME="$TMP" PATH="$TMP/bin:$PATH" CLAUDEX_CONFIG_FILE="$TMP/config" CLAUDEX_STATE_DIR="$TMP/state" CLAUDEX_PORT="$PORT" \
        CLAUDEX_CLAUDE_BIN="$TMP/bin/claude" CLAUDEX_PROXY_BIN="$TMP/bin/proxy" ASAN_OPTIONS=detect_leaks=0 \
        CLAUDEX_TEST_UPSTREAM="http://127.0.0.1:$UP_PORT/backend-api/codex/responses" "$@"
}
service_exec() {
    exec env -i HOME="$TMP" PATH="$TMP/bin:$PATH" CLAUDEX_CONFIG_FILE="$TMP/config" CLAUDEX_STATE_DIR="$TMP/state" CLAUDEX_PORT="$PORT" \
        CLAUDEX_CLAUDE_BIN="$TMP/bin/claude" CLAUDEX_PROXY_BIN="$TMP/bin/proxy" ASAN_OPTIONS=detect_leaks=0 \
        CLAUDEX_TEST_UPSTREAM="http://127.0.0.1:$UP_PORT/backend-api/codex/responses" "$W" proxy-exec
}
health() { curl -fsS -m 2 "http://127.0.0.1:$PORT/healthz" 2>/dev/null; }
wait_health() {
    local url=$1
    for _ in $(seq 50); do
        curl -fsS -m 1 "$url" >/dev/null 2>&1 && return 0
        sleep 0.1
    done
    return 1
}
require_ours() {
    [[ "$(w "$W" status --json | jq -r '.proxy.ours')" == true ]] || fail_setup "proxy on port $PORT is not ours"
}
require_service() {
    local child=$1
    wait_health "http://127.0.0.1:$PORT/healthz" || fail_setup "service proxy did not start"
    [[ "$(health | jq -r '.pid // empty' 2>/dev/null)" == "$child" ]] || fail_setup "service process does not own proxy port"
    require_ours
}

health >/dev/null && fail_setup "proxy port is already occupied"
up_ready=0
for _ in $(seq 50); do
    if ! child_is_running "$UP_PID"; then break; fi
    if curl -fsS -m 1 --data '{}' "http://127.0.0.1:$UP_PORT/backend-api/codex/responses" 2>/dev/null | grep -q 'response.completed'; then
        up_ready=1; break
    fi
    sleep 0.1
done
[[ "$up_ready" == 1 ]] || fail_setup "fake upstream did not start"
echo "  first run starts the proxy on demand and goes through it"
out=$(echo "task" | w "$W" run luna 2>&1); rc=$?
[[ "$rc" == 0 ]] || fail_setup "on-demand proxy did not start: $out"
require_ours
check "run ok" "$rc" "0"
contains "answer came through the proxy" "$out" "via proxy: hello"
check "proxy now up" "$(health | jq -r .service)" "claudex-proxy"
check "proxy instance matches the launcher's record" "$(health | jq -r .instance)" "$(cat "$TMP/state/instance" 2>/dev/null)"
check "instance file is private" "$(stat -c %a "$TMP/state/instance" 2>/dev/null)" "600"
contains "fallback lineup on healthz" "$(health)" '"sol":"gpt-6.1-sol"'
contains "status prints model mapping" "$(w "$W" status)" "models: luna=gpt-6-luna sol=gpt-6.1-sol astra=gpt-6-astra (fallback)"
contains "SessionStart policy includes model mapping" "$(w "$W" policy-line)" "models: luna=gpt-6-luna sol=gpt-6.1-sol astra=gpt-6-astra (fallback)"
check "status JSON has models" "$(w "$W" status --json | jq -r '.models.sol')" "gpt-6.1-sol"
check "installed CLI version passed to proxy" "$(< "$TMP/versions")" "0.161.0"
pid1=$(health | jq -r .pid)

echo "  second run reuses it"
echo "task" | w "$W" run luna >/dev/null 2>&1
check "same proxy pid" "$(health | jq -r .pid)" "$pid1"

echo "  status"
contains "status shows proxy up and ours" "$(w "$W" status)" "proxy=up port=$PORT ours=yes"

echo "  stop-proxy"
w "$W" stop-proxy >/dev/null || fail_setup "could not stop on-demand proxy"
for _ in $(seq 30); do health >/dev/null || break; sleep 0.1; done
health >/dev/null && fail_setup "on-demand proxy did not stop"
check "proxy stopped" "$(health | jq -r .ok 2>/dev/null)" ""

echo "  proxy-exec (what systemd/OpenRC run): foreground proxy with a fresh nonce"
service_exec > "$TMP/svc1.log" 2>&1 & SVC1=$!
require_service "$SVC1"
check "service proxy is up" "$(health | jq -r .service)" "claudex-proxy"
check "proxy-exec forwards CLI version" "$(wc -l < "$TMP/versions" | tr -d ' ')" "2"
check "service wrote the nonce the proxy reports" "$(health | jq -r .instance)" "$(cat "$TMP/state/instance" 2>/dev/null)"
check "nonce file is private" "$(stat -c %a "$TMP/state/instance")" "600"
contains "workers accept the service-managed proxy" "$(w "$W" status)" "ours=yes"
svcpid=$(health | jq -r .pid)
out=$(echo "task" | w "$W" run luna 2>&1)
contains "worker runs through the service-managed proxy" "$out" "via proxy: hello"
check "worker did not start a second proxy" "$(health | jq -r .pid)" "$svcpid"
signal_child "$SVC1" || fail_setup "service proxy already exited"
wait "$SVC1" 2>/dev/null || true; SVC1=
for _ in $(seq 30); do health >/dev/null || break; sleep 0.1; done
health >/dev/null && fail_setup "service proxy did not exit"
check "foreground proxy exits when signalled (so the supervisor sees it)" "$(health | jq -r .ok 2>/dev/null)" ""

echo "  proxy-exec takes over an on-demand proxy so the service owns the port"
echo "task" | w "$W" run luna >/dev/null 2>&1 || fail_setup "on-demand proxy did not restart"
require_ours
ondemand=$(health | jq -r .pid)
service_exec > "$TMP/svc2.log" 2>&1 & SVC2=$!
for _ in $(seq 80); do p=$(health | jq -r '.pid // empty' 2>/dev/null); [ -n "$p" ] && [ "$p" == "$SVC2" ] && break; sleep 0.1; done
require_service "$SVC2"
newpid=$(health | jq -r .pid)
check "a different proxy now holds the port" "$([ "$newpid" != "$ondemand" ] && echo yes || echo no)" "yes"
check "the on-demand proxy released the port" "$([[ "$newpid" != "$ondemand" ]] && echo yes || echo no)" "yes"
contains "and it is recognised as ours" "$(w "$W" status)" "ours=yes"
signal_child "$SVC2" || fail_setup "replacement service already exited"
wait "$SVC2" 2>/dev/null || true; SVC2=
for _ in $(seq 30); do health >/dev/null || break; sleep 0.1; done
health >/dev/null && fail_setup "replacement service did not exit"

echo "  refuses a foreign listener on the port, even one that claims to be claudex-proxy"
CAPTURE="$TMP/foreign.captured"
python3 - "$PORT" "$CAPTURE" <<'EOF' & SQUAT_PID=$!
import sys, http.server
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        b = b'{"ok":true,"service":"claudex-proxy","version":"0.1.0","pid":1,"instance":"guess"}'
        self.send_response(200); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        open(sys.argv[2], "w").write("captured"); self.send_response(200); self.end_headers()
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
EOF
wait_health "http://127.0.0.1:$PORT/healthz" || fail_setup "foreign test listener did not start"
[[ "$(health | jq -r '.instance // empty' 2>/dev/null)" == guess ]] || fail_setup "foreign test listener does not own proxy port"
child_is_running "$SQUAT_PID" || fail_setup "foreign test listener exited"
out=$(echo "secret task" | w "$W" run luna 2>&1); rc=$?
check "refuses with exit 6" "$rc" "6"
contains "says why" "$out" "refusing"
check "foreign listener never received worker POST" "$([[ -e "$CAPTURE" ]] && echo yes || echo no)" "no"
out=$(w "$W" stop-proxy 2>&1); check "stop-proxy will not kill a foreign process" "$?" "6"
if child_is_running "$SQUAT_PID"; then checks=$((checks+1)); else checks=$((checks+1)); fails=$((fails+1)); echo "    FAIL: foreign listener was killed"; fi

out=$(w "$W" proxy-exec 2>&1); check "proxy-exec refuses to displace a foreign listener -> exit 6" "$?" "6"
if child_is_running "$SQUAT_PID"; then checks=$((checks+1)); else checks=$((checks+1)); fails=$((fails+1)); echo "    FAIL: proxy-exec killed the foreign listener"; fi
check "foreign listener never received a POST" "$([[ -e "$CAPTURE" ]] && echo yes || echo no)" "no"

echo "  finds claudex-proxy next to itself when PATH lacks it (service managers have a bare PATH)"
signal_child "$SQUAT_PID" || fail_setup "foreign test listener already exited"
wait "$SQUAT_PID" 2>/dev/null || true; SQUAT_PID=
for _ in $(seq 30); do health >/dev/null || break; sleep 0.1; done
health >/dev/null && fail_setup "foreign test listener still owns proxy port"
mkdir -p "$TMP/sib" && cp "$W" "$TMP/sib/claudex-worker" && ln -s "$ROOT/build/claudex-proxy-test" "$TMP/sib/claudex-proxy"
env -i HOME="$TMP" PATH="/usr/bin:/bin" CLAUDEX_STATE_DIR="$TMP/state" CLAUDEX_PORT="$PORT" ASAN_OPTIONS=detect_leaks=0 \
    CLAUDEX_TEST_UPSTREAM="http://127.0.0.1:$UP_PORT/backend-api/codex/responses" "$TMP/sib/claudex-worker" proxy-exec > "$TMP/svc3.log" 2>&1 & SVC3=$!
require_service "$SVC3"
check "sibling proxy was found and started" "$(health | jq -r .service 2>/dev/null)" "claudex-proxy"
signal_child "$SVC3" || fail_setup "sibling proxy already exited"
wait "$SVC3" 2>/dev/null || true; SVC3=
for _ in $(seq 30); do health >/dev/null || break; sleep 0.1; done
health >/dev/null && fail_setup "sibling proxy did not exit"

echo "  a missing proxy binary is reported, and nothing in the message is executed"
mkdir -p "$TMP/trap" && cat > "$TMP/trap/make" <<'EOT'
#!/usr/bin/env bash
touch "$(dirname "$0")/make-was-run"
EOT
chmod +x "$TMP/trap/make"
MISSING_PORT=$(free_port) || fail_setup "cannot select missing-proxy test port"
[[ -n "$MISSING_PORT" && "$MISSING_PORT" != "$PORT" && "$MISSING_PORT" != "$UP_PORT" ]] || fail_setup "missing-proxy test port overlaps"
out=$(echo x | env -i HOME="$TMP" PATH="$TMP/trap:$PATH" CLAUDEX_STATE_DIR="$TMP/state2" CLAUDEX_PORT="$MISSING_PORT" \
    CLAUDEX_PROXY_BIN=no-such-claudex-proxy CLAUDEX_CLAUDE_BIN=true "$W" run luna 2>&1); rc=$?
check "missing proxy -> exit 6" "$rc" "6"
contains "message mentions make install" "$out" "make install"
check "make was not executed by the error message" "$([ -e "$TMP/trap/make-was-run" ] && echo ran || echo no)" "no"

echo "  catalog fetch from a local fixture and unsupported-model re-resolution"
cat > "$TMP/model_backend.py" <<'PY'
import json
import pathlib
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

fixture = pathlib.Path(sys.argv[2]).read_bytes()
log = pathlib.Path(sys.argv[3])

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def respond(self, code, payload, content_type):
        self.send_response(code)
        self.send_header('content-type', content_type)
        self.send_header('content-length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        with log.open('a') as f:
            f.write('GET ' + self.path + ' originator=' + self.headers.get('originator', '') +
                    ' accept=' + self.headers.get('accept', '') + '\n')
        self.respond(200, fixture, 'application/json')

    def do_POST(self):
        data = self.rfile.read(int(self.headers['content-length']))
        model = json.loads(data)['model']
        with log.open('a') as f:
            f.write('POST model=' + model + '\n')
        if model == 'gpt-6.1-sol':
            self.respond(400, b'{"error":{"message":"The gpt-6.1-sol model is not supported"}}', 'application/json')
        else:
            self.respond(200, b'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n', 'text/event-stream')

ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), Handler).serve_forever()
PY
MODEL_BACKEND_PORT=$(free_port) || fail_setup "cannot select model backend port"
MODEL_PROXY_PORT=$(free_port) || fail_setup "cannot select model proxy port"
[[ -n "$MODEL_BACKEND_PORT" && -n "$MODEL_PROXY_PORT" && "$MODEL_BACKEND_PORT" != "$MODEL_PROXY_PORT" &&
   "$MODEL_BACKEND_PORT" != "$UP_PORT" && "$MODEL_BACKEND_PORT" != "$PORT" &&
   "$MODEL_PROXY_PORT" != "$UP_PORT" && "$MODEL_PROXY_PORT" != "$PORT" ]] || fail_setup "model test ports overlap"
python3 "$TMP/model_backend.py" "$MODEL_BACKEND_PORT" "$ROOT/tests/fixtures/models-2026-10-03.json" "$TMP/model_backend.log" & MODEL_BACKEND_PID=$!
for _ in $(seq 50); do
    curl -fsS -m 1 "http://127.0.0.1:$MODEL_BACKEND_PORT/backend-api/codex/models?client_version=0.161.0" >/dev/null 2>&1 && break
    sleep 0.1
done
child_is_running "$MODEL_BACKEND_PID" || fail_setup "model backend did not start"
[[ -s "$TMP/model_backend.log" ]] || fail_setup "model backend did not answer"
: > "$TMP/model_backend.log"
ASAN_OPTIONS=detect_leaks=0 CLAUDEX_INSTANCE=modeltest CLAUDEX_CODEX_VERSION=0.161.0 \
    CLAUDEX_TEST_UPSTREAM="http://127.0.0.1:$MODEL_BACKEND_PORT/backend-api/codex/responses" \
    "$ROOT/build/claudex-proxy-test" --port "$MODEL_PROXY_PORT" --auth-file "$TMP/.codex/auth.json" \
    > "$TMP/model_proxy.log" 2>&1 & MODEL_PROXY_PID=$!
MODEL_URL="http://127.0.0.1:$MODEL_PROXY_PORT"
for _ in $(seq 50); do
    source=$(curl -fsS -m 1 "$MODEL_URL/healthz" 2>/dev/null | jq -r '.models.source // empty')
    [ "$source" = backend ] && break
    sleep 0.1
done
[[ "$source" == backend ]] || fail_setup "model proxy did not load backend fixture"
model_health=$(curl -fsS -m 1 "$MODEL_URL/healthz") || fail_setup "model proxy is not healthy"
[[ "$(jq -r '.pid // empty' <<< "$model_health")" == "$MODEL_PROXY_PID" &&
   "$(jq -r '.instance // empty' <<< "$model_health")" == modeltest ]] || fail_setup "model proxy does not own its port"
check "fixture installed under the proxy sandbox" "$source" backend
check "backend sol is the latest served model" "$(curl -fsS -m 1 "$MODEL_URL/healthz" | jq -r '.models.sol')" gpt-6.1-sol
check "only three current families are advertised" "$(curl -fsS -m 1 "$MODEL_URL/v1/models" | jq -r '[.data[].id] | join(",")')" gpt-6-luna,gpt-6.1-sol,gpt-6-astra
contains "fetch uses installed Codex version and honest header" "$(< "$TMP/model_backend.log")" 'GET /backend-api/codex/models?client_version=0.161.0 originator=claude-code accept=application/json'
unknown='{"model":"gpt-pluto","messages":[{"role":"user","content":"hi"}]}'
code=$(curl -sS -m 5 -o "$TMP/model_response" -w '%{http_code}' -H 'content-type: application/json' --data "$unknown" "$MODEL_URL/v1/messages")
check "unknown family is rejected" "$code" 404
contains "unknown-model error names current catalog" "$(< "$TMP/model_response")" 'gpt-6.1-sol'
request='{"model":"gpt-sol","messages":[{"role":"user","content":"hi"}]}'
code=$(curl -sS -m 5 -o "$TMP/model_response" -w '%{http_code}' -H 'content-type: application/json' --data "$request" "$MODEL_URL/v1/messages")
check "unsupported slug returns the backend error" "$code" 400
contains "error is not hidden" "$(< "$TMP/model_response")" 'not supported'
check "rejected sol now resolves to next lower served version" "$(curl -fsS -m 1 "$MODEL_URL/healthz" | jq -r '.models.sol')" gpt-6-sol
code=$(curl -sS -m 5 -o "$TMP/model_response" -w '%{http_code}' -H 'content-type: application/json' --data "$request" "$MODEL_URL/v1/messages")
check "caller retry uses the replacement" "$code" 200
contains "retry sent listed replacement, not guessed slug" "$(< "$TMP/model_backend.log")" 'POST model=gpt-6-sol'
cleanup_children "$MODEL_PROXY_PID" "$MODEL_BACKEND_PID"
MODEL_PROXY_PID= MODEL_BACKEND_PID=

echo "  $checks checks, $fails failures"
exit $((fails > 0))
