#!/usr/bin/env bash
# Spike 0: does the ChatGPT Codex backend serve each tier on the NORMAL lane to an
# honestly identified third-party client? No internal/lite headers are ever sent.
# The access token goes shell-builtin -> curl stdin; it never appears in argv or output.
set -euo pipefail

AUTH="${CODEX_HOME:-$HOME/.codex}/auth.json"
OUT="$(cd "$(dirname "$0")" && pwd)/raw"
URL="https://chatgpt.com/backend-api/codex/responses"
UA="claudex/0.1 (Claude Code; third-party harness)"
mkdir -p "$OUT"
chmod 700 "$OUT"

probe() { # probe <tag> <body-json-file>
    local tag=$1 body=$2 sid status
    sid=$(cat /proc/sys/kernel/random/uuid)
    status=$(
        printf 'header = "Authorization: Bearer %s"\nheader = "ChatGPT-Account-ID: %s"\n' \
            "$(jq -r '.tokens.access_token' "$AUTH")" "$(jq -r '.tokens.account_id' "$AUTH")" |
        curl -sS -N --config - --max-time 180 \
            -H "Content-Type: application/json" -H "Accept: text/event-stream" \
            -H "originator: claude-code" -H "User-Agent: $UA" -H "session-id: $sid" \
            --data-binary @"$body" -D "$OUT/$tag.hdr" -o "$OUT/$tag.out" -w '%{http_code}' "$URL" || true
    )
    echo "== $tag: HTTP $status"
    if [ "$status" = "200" ]; then
        grep -o '"type":"response\.[a-z_.]*"' "$OUT/$tag.out" | sort | uniq -c | sed 's/^/     /'
        # final output text, if any
        grep '"type":"response.output_text.done"' "$OUT/$tag.out" | head -1 |
            sed 's/^data: //' | jq -r '"     text: " + (.text // "" | .[0:200])' 2>/dev/null || true
    else
        head -c 700 "$OUT/$tag.out" | sed 's/^/     /'; echo
    fi
    grep -i '^x-codex-\(primary\|secondary\)-used-percent\|^x-codex-plan' "$OUT/$tag.hdr" | sed 's/^/     /' || true
}

text_body() { # text_body <model> <effort>
    jq -n --arg model "$1" --arg effort "$2" '{
        model: $model,
        instructions: "You are a coding assistant running inside Claude Code.",
        input: [{type:"message", role:"user", content:[{type:"input_text", text:"Reply with exactly one word: hello"}]}],
        tools: [], tool_choice: "auto", parallel_tool_calls: true,
        reasoning: {effort: $effort, summary: "auto"},
        store: false, stream: true, include: ["reasoning.encrypted_content"],
        text: {verbosity: "low"}
    }'
}

case "${1:-tiers}" in
tiers)
    for m in gpt-6-luna gpt-5.6-terra gpt-6-sol gpt-6-astra; do
        text_body "$m" low > "$OUT/$m.req.json"
        probe "$m" "$OUT/$m.req.json"
    done
    ;;
*)
    echo "usage: $0 [tiers]" >&2; exit 2 ;;
esac
