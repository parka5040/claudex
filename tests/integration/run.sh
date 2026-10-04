#!/usr/bin/env bash
# End-to-end test of claudex-proxy against a fake upstream. No real credentials, no network.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$ROOT/build/claudex-proxy-test"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/claudex-it-XXXXXX")" || { printf '    FAIL: cannot create integration test directory\n' >&2; exit 1; }
[[ -d "$TMP" ]] || { printf '    FAIL: integration test directory is missing\n' >&2; exit 1; }
FAKE_TOKEN="FAKE-TOKEN-$RANDOM-do-not-log"
fails=0 checks=0

free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
UP_PORT=$(free_port); PX_PORT=$(free_port)
PX="http://127.0.0.1:$PX_PORT"

cleanup() { kill "${UP_PID:-}" "${PX_PID:-}" 2>/dev/null; wait 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

ok()   { checks=$((checks+1)); }
bad()  { checks=$((checks+1)); fails=$((fails+1)); echo "    FAIL: $*"; }
check() { # check <description> <got> <want>
    if [ "$2" = "$3" ]; then ok; else bad "$1: got '$2', want '$3'"; fi
}
contains() { # contains <description> <haystack> <needle>
    case "$2" in *"$3"*) ok ;; *) bad "$1: '$3' not found in: ${2:0:300}" ;; esac
}
absent() { case "$2" in *"$3"*) bad "$1: '$3' unexpectedly present" ;; *) ok ;; esac; }
set_mode() { echo "$1" > "$TMP/state/mode"; : > "$TMP/state/requests"; }
last_req() { tail -n 1 "$TMP/state/requests"; }

write_auth() { # write_auth <token>
    printf '{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"id_token":"x","access_token":"%s","refresh_token":"r","account_id":"acct-test"},"last_refresh":"2026-01-01T00:00:00Z"}' "$1" > "$TMP/codex/auth.json.new"
    mv "$TMP/codex/auth.json.new" "$TMP/codex/auth.json"   # rename, like Codex does
}

post() { # post <path> <json> [extra curl args...]  -> body on stdout, status in $TMP/status
    local path=$1 body=$2; shift 2
    curl -sS -N --max-time 20 -o "$TMP/out" -w '%{http_code}' -H 'content-type: application/json' \
        -H 'x-api-key: claudex-local' "$@" --data-binary "$body" "$PX$path" > "$TMP/status" 2>"$TMP/curl.err"
    cat "$TMP/out"
}
status() { cat "$TMP/status"; }

MSG='{"model":"gpt-6-sol","max_tokens":100,"stream":true,"system":"Be brief.","messages":[{"role":"user","content":"hi"}],"metadata":{"user_id":"user_x_account_y_session_11111111-2222-3333-4444-555555555555"}}'
MSG_NOSTREAM='{"model":"gpt-6-sol","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}'

mkdir -p "$TMP/state" "$TMP/codex"
write_auth "$FAKE_TOKEN"
set_mode text

python3 "$ROOT/tests/fake_upstream/server.py" "$UP_PORT" "$TMP/state" & UP_PID=$!
ASAN_OPTIONS=detect_leaks=0 CLAUDEX_INSTANCE=nonce123abc CLAUDEX_TEST_UPSTREAM="http://127.0.0.1:$UP_PORT/backend-api/codex/responses" \
    "$BIN" --port "$PX_PORT" --auth-file "$TMP/codex/auth.json" 2> "$TMP/proxy.log" & PX_PID=$!

for _ in $(seq 50); do curl -fsS -m 1 "$PX/healthz" >/dev/null 2>&1 && break; sleep 0.1; done

echo "  healthz"
check "healthz body" "$(curl -sS -m 2 "$PX/healthz" | jq -r .ok)" "true"
check "healthz reports the instance nonce it was started with" "$(curl -sS -m 2 "$PX/healthz" | jq -r .instance)" "nonce123abc"
check "healthz reports its pid" "$(curl -sS -m 2 "$PX/healthz" | jq -r .pid)" "$PX_PID"

echo "  streaming text turn"
out=$(post /v1/messages "$MSG")
check "status" "$(status)" "200"
check "event order" "$(grep '^event: ' <<<"$out" | sed 's/event: //' | tr '\n' ' ')" \
    "message_start content_block_start content_block_delta content_block_stop message_delta message_stop "
contains "text delta" "$out" '"text":"hello"'
contains "reports client model" "$out" '"model":"gpt-6-sol"'

echo "  upstream request is honest and well-formed"
req=$(last_req)
check "path" "$(jq -r .path <<<"$req")" "/backend-api/codex/responses"
check "bearer" "$(jq -r '.headers.authorization' <<<"$req")" "Bearer $FAKE_TOKEN"
check "account id" "$(jq -r '.headers["chatgpt-account-id"]' <<<"$req")" "acct-test"
check "originator" "$(jq -r '.headers.originator' <<<"$req")" "claude-code"
contains "user agent" "$(jq -r '.headers["user-agent"]' <<<"$req")" "claudex/"
contains "user agent says third party" "$(jq -r '.headers["user-agent"]' <<<"$req")" "third-party harness"
check "session-id header" "$(jq -r '.headers["session-id"]' <<<"$req")" "11111111-2222-3333-4444-555555555555"
check "accept" "$(jq -r '.headers.accept' <<<"$req")" "text/event-stream"
absent "no internal headers" "$(jq -r '.headers | keys | join(" ")' <<<"$req")" "x-openai-internal"
absent "no codex_cli_rs" "$req" "codex_cli_rs"
absent "client api key not forwarded" "$req" "claudex-local"
check "upstream model" "$(jq -r '.body | fromjson | .model' <<<"$req")" "gpt-6.1-sol"
check "upstream instructions" "$(jq -r '.body | fromjson | .instructions' <<<"$req")" "Be brief."
check "store false" "$(jq -r '.body | fromjson | .store' <<<"$req")" "false"

echo "  non-streaming turn"
out=$(post /v1/messages "$MSG_NOSTREAM")
check "status" "$(status)" "200"
check "type" "$(jq -r .type <<<"$out")" "message"
check "text" "$(jq -r '.content[0].text' <<<"$out")" "hello"
check "stop_reason" "$(jq -r .stop_reason <<<"$out")" "end_turn"
check "usage" "$(jq -r .usage.input_tokens <<<"$out")" "27"

echo "  tool call with reasoning, stream split mid-event"
set_mode tool
out=$(post /v1/messages "$MSG")
contains "thinking signature" "$out" '"signature":"cx1:rs_1:ENCRYPTED"'
contains "tool_use block" "$out" '"type":"tool_use","id":"call_77","name":"Read"'
contains "stop reason tool_use" "$out" '"stop_reason":"tool_use"'
contains "cached tokens split" "$out" '"input_tokens":40'
out=$(post /v1/messages "$MSG_NOSTREAM")
check "non-stream tool input" "$(jq -r '.content[] | select(.type=="tool_use") | .input.file_path' <<<"$out")" "/tmp/a"
set_mode slow
out=$(post /v1/messages "$MSG")
contains "slow chunked stream still yields text" "$out" '"text":"hello"'

echo "  upstream errors"
set_mode 401
out=$(post /v1/messages "$MSG")
check "401 status" "$(status)" "401"
check "401 type" "$(jq -r .error.type <<<"$out")" "authentication_error"
contains "401 tells user to run codex" "$(jq -r .error.message <<<"$out")" "codex"
check "401 retried exactly once after re-reading auth" "$(wc -l < "$TMP/state/requests" | tr -d ' ')" "1"
set_mode 429
out=$(post /v1/messages "$MSG" -D "$TMP/hdr")
check "429 status" "$(status)" "429"
check "429 type" "$(jq -r .error.type <<<"$out")" "rate_limit_error"
contains "429 message" "$(jq -r .error.message <<<"$out")" "usage limit"
contains "429 retry-after" "$(tr -d '\r' < "$TMP/hdr" | tr 'A-Z' 'a-z')" "retry-after: 1234"
set_mode truncated
out=$(post /v1/messages "$MSG")
check "truncated stream status" "$(status)" "200"
check "truncated stream ends with error event" "$(grep '^event: ' <<<"$out" | tail -1)" "event: error"
out=$(post /v1/messages "$MSG_NOSTREAM")
check "truncated non-stream is 502" "$(status)" "502"

echo "  token rotation is picked up without restart"
set_mode text
write_auth "ROTATED-$FAKE_TOKEN"
post /v1/messages "$MSG" >/dev/null
check "rotated bearer" "$(jq -r '.headers.authorization' <<<"$(last_req)")" "Bearer ROTATED-$FAKE_TOKEN"

echo "  missing login"
mv "$TMP/codex/auth.json" "$TMP/codex/auth.json.bak"
out=$(post /v1/messages "$MSG")
check "no auth status" "$(status)" "401"
contains "no auth message" "$(jq -r .error.message <<<"$out")" "codex login"
mv "$TMP/codex/auth.json.bak" "$TMP/codex/auth.json"

echo "  request validation and routing"
out=$(post /v1/messages '{"model":"gpt-5.6","messages":[]}');      check "unknown model" "$(status)" "404"
check "unknown model type" "$(jq -r .error.type <<<"$out")" "not_found_error"
post /v1/messages '{oops' >/dev/null;                               check "bad json" "$(status)" "400"
post /v1/nope '{}' >/dev/null;                                      check "unknown path" "$(status)" "404"
check "GET unknown path" "$(curl -sS -m 2 -o /dev/null -w '%{http_code}' "$PX/")" "404"
out=$(post /v1/messages/count_tokens "$MSG_NOSTREAM");              check "count_tokens status" "$(status)" "200"
check "count_tokens positive" "$(jq -r '.input_tokens > 0' <<<"$out")" "true"
check "models list" "$(curl -sS -m 2 "$PX/v1/models" | jq -r '.data | map(.id) | join(",")')" \
    "gpt-6-luna,gpt-6.1-sol,gpt-6-astra"

echo "  concurrent requests"
set_mode slow
for i in 1 2 3 4 5 6; do
    curl -sS -N -m 20 -H 'content-type: application/json' --data-binary "$MSG" "$PX/v1/messages" > "$TMP/par.$i" 2>/dev/null &
    pids[$i]=$!
done
for i in 1 2 3 4 5 6; do wait "${pids[$i]}"; done
n=0; for i in 1 2 3 4 5 6; do grep -q '^event: message_stop' "$TMP/par.$i" && n=$((n+1)); done
check "all 6 parallel streams completed" "$n" "6"

echo "  secrets never reach the log; proxy survived"
absent "token absent from proxy log" "$(cat "$TMP/proxy.log")" "$FAKE_TOKEN"
absent "no sanitizer reports" "$(cat "$TMP/proxy.log")" "Sanitizer"
contains "log has metadata lines" "$(cat "$TMP/proxy.log")" "model=gpt-6.1-sol"
contains "log surfaces rate-limit header" "$(cat "$TMP/proxy.log")" "used_pct=42"
if kill -0 "$PX_PID" 2>/dev/null; then ok; else bad "proxy died during the run"; fi

echo "  $checks checks, $fails failures"
[ "$fails" -eq 0 ] || { echo "  --- proxy log tail:"; tail -n 15 "$TMP/proxy.log" | sed 's/^/    /'; }
exit $((fails > 0))
