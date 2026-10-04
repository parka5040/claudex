#!/usr/bin/env bash
# Throwaway deterministic native-agent and Codex lineup probes. Never print secrets.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD/spikes/native-agents"
CAP="$ROOT/captures"
MOD="$ROOT/mod-b"
AUTH="${CODEX_HOME:-$HOME/.codex}/auth.json"
UA='claudex/0.1 (Claude Code; third-party harness)'
mkdir -p "$CAP"
umask 077

probe() {
    local name=$1 url=$2 request=${3:-} code
    local -a flags=(-sS -N --max-time 180 -H 'originator: claude-code' -H "User-Agent: $UA")
    if [[ -n "$request" ]]; then
        flags+=(-H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
                -H "session-id: $(< /proc/sys/kernel/random/uuid)" --data-binary "@$request")
    fi
    code=$(printf 'header = "Authorization: Bearer %s"\nheader = "ChatGPT-Account-ID: %s"\n' \
        "$(jq -r '.tokens.access_token' "$AUTH")" "$(jq -r '.tokens.account_id' "$AUTH")" |
        curl --config - "${flags[@]}" -o "$CAP/b-${name}-raw.txt" -w '%{http_code}' "$url")
    printf '%s HTTP %s\n' "$name" "$code"
    if [[ "$name" == models ]]; then
        jq '{keys:keys, count:(.models|length), models:[.models[]|{slug,priority,visibility,supported_in_api}]}' "$CAP/b-${name}-raw.txt"
    elif [[ "$code" == 200 ]]; then
        jq -Rr 'select(startswith("data: ")) | sub("^data: ";"") | fromjson? | select(.type == "response.output_text.done") | (.text // "" | .[0:160])' "$CAP/b-${name}-raw.txt"
    else
        jq -r '.error.message // .detail // .message // "no JSON error" | .[0:160]' "$CAP/b-${name}-raw.txt" 2>/dev/null || printf 'no JSON error\n'
    fi
}

case "${1:-}" in
c)
    probe models 'https://chatgpt.com/backend-api/codex/models?client_version=0.160.0'
    for model in gpt-6.1-sol gpt-6.1-luna gpt-6.1-astra; do
        jq -n --arg model "$model" '{model:$model,
          instructions:"You are a coding assistant running inside Claude Code.",
          input:[{type:"message",role:"user",content:[{type:"input_text",text:"Reply with exactly one word: hello"}]}],
          tools:[],tool_choice:"auto",parallel_tool_calls:true,
          reasoning:{effort:"low",summary:"auto"},store:false,stream:true,
          include:["reasoning.encrypted_content"],text:{verbosity:"low"}}' > "$CAP/b-$model-request.txt"
        probe "$model" 'https://chatgpt.com/backend-api/codex/responses' "$CAP/b-$model-request.txt"
    done
    ;;
b)
    kind=${2:-foreground}
    case "$kind" in
        foreground) printf '{"background":false,"short":false}\n' > "$MOD/mode.json" ;;
        background) printf '{"background":true,"short":true}\n' > "$MOD/mode.json" ;;
        cancel) printf '{"background":false,"short":false}\n' > "$MOD/mode.json" ;;
        taskstop) printf '{"background":true,"short":false,"cancel":true}\n' > "$MOD/mode.json" ;;
        *) printf 'usage: %s b [foreground|background|cancel|taskstop]\n' "$0" >&2; exit 2 ;;
    esac
    for name in started pid finally agents transcript transcript-error; do
        [[ ! -e "$CAP/b-$name.txt" ]] || rm -- "$CAP/b-$name.txt"
    done
    if [[ "$kind" == cancel ]]; then
        claude -p --model gpt-6-luna --plugin-dir "$MOD" --output-format json --max-turns 4 \
            'Invoke the spike agent.' < /dev/null > "$CAP/b-cancel-output.txt" 2> "$CAP/b-cancel-stderr.txt" &
        child=$!
        for _ in {1..100}; do
            [[ ! -s "$CAP/b-pid.txt" ]] || break
            sleep 0.2
        done
        [[ -s "$CAP/b-pid.txt" && -s "$CAP/b-started.txt" ]] || { printf 'ticker never started\n' >&2; exit 1; }
        cp "$CAP/b-started.txt" "$CAP/b-cancel-started.txt"
        cp "$CAP/b-pid.txt" "$CAP/b-cancel-pid.txt"
        sleep 30
        kill -INT "$child"
        rc=0
        wait "$child" || rc=$?
        [[ ! -f "$CAP/b-finally.txt" ]] || cp "$CAP/b-finally.txt" "$CAP/b-cancel-finally.txt"
        ticker_pid=$(< "$CAP/b-cancel-pid.txt")
        printf 'nested_exit=%s\n' "$rc" | tee "$CAP/b-cancel-status.txt"
        if ps -o pid,ppid,stat,etime,comm -p "$ticker_pid" > "$CAP/b-cancel-ps.txt"; then
            printf 'ticker still exists: %s\n' "$ticker_pid"
            exit 1
        fi
        printf 'ticker pid %s gone; finally=%s\n' "$ticker_pid" "$([[ -f "$CAP/b-cancel-finally.txt" ]] && printf yes || printf NO)" | tee -a "$CAP/b-cancel-status.txt"
    elif [[ "$kind" == background || "$kind" == taskstop ]]; then
        claude -p --model gpt-6-luna --plugin-dir "$MOD" --output-format stream-json --verbose --max-turns 4 \
            'Invoke the spike agent.' < /dev/null > "$CAP/b-$kind-events.txt" 2> "$CAP/b-$kind-stderr.txt"
        jq -c '{type,subtype,status:(.status//null),usage:(.usage//null),result:(.result//null)}' "$CAP/b-$kind-events.txt"
    else
        claude -p --model gpt-6-luna --plugin-dir "$MOD" --output-format json --max-turns 4 \
            'Invoke the spike agent.' < /dev/null > "$CAP/b-$kind-output.txt" 2> "$CAP/b-$kind-stderr.txt"
        jq '{is_error,result,num_turns,usage,subtype}' "$CAP/b-$kind-output.txt"
    fi
    ;;
ui-b)
    printf '{"background":false,"short":true}\n' > "$MOD/mode.json"
    /tmp/claudex-spike-b-venv/bin/python "$MOD/ui.py"
    ;;
*) printf 'usage: %s {b [foreground|background|cancel]|c|ui-b}\n' "$0" >&2; exit 2 ;;
esac
