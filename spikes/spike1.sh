#!/usr/bin/env bash
# Spike 1: the real (release, sandboxed) proxy against the real backend, driven with
# Anthropic-format requests. Verifies: text turn, function tools on Astra, and the
# stateless reasoning round-trip (thinking signature -> reasoning item) across a tool loop.
# The proxy reads ~/.codex/auth.json itself; this script never touches the token.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/spikes/raw"; mkdir -p "$OUT"; chmod 700 "$OUT"
PORT=18799
PX="http://127.0.0.1:$PORT"

"$ROOT/build/claudex-proxy" --port "$PORT" 2> "$OUT/spike1.proxy.log" & PX_PID=$!
trap 'kill $PX_PID 2>/dev/null' EXIT
for _ in $(seq 50); do curl -fsS -m 1 "$PX/healthz" >/dev/null 2>&1 && break; sleep 0.1; done
curl -fsS -m 2 "$PX/healthz" || { echo "proxy did not start:"; cat "$OUT/spike1.proxy.log"; exit 1; }
echo

post() { curl -sS -m 300 -o "$OUT/$1.json" -w '%{http_code}' -H 'content-type: application/json' --data-binary @"$2" "$PX/v1/messages"; }

SYSTEM="You are Claude Code, Anthropic's official CLI for Claude. You are an interactive agent that helps users with software engineering tasks. $(printf 'Follow the conventions of the surrounding code. %.0s' $(seq 120))"
TOOLS='[{"name":"Read","description":"Reads a file from the local filesystem.","input_schema":{"type":"object","properties":{"file_path":{"type":"string","description":"Absolute path","pattern":"^/"},"limit":{"type":"integer","minimum":1}},"required":["file_path"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}}]'

echo "== A. streamed text turn on terra, Claude-Code-sized system prompt"
jq -n --arg sys "$SYSTEM" '{model:"gpt-5.6-terra",max_tokens:200,stream:true,system:$sys,messages:[{role:"user",content:"Reply with exactly: ready"}]}' > "$OUT/a.req"
code=$(curl -sS -N -m 120 -o "$OUT/a.sse" -w '%{http_code}' -H 'content-type: application/json' --data-binary @"$OUT/a.req" "$PX/v1/messages")
echo "   HTTP $code; events: $(grep '^event: ' "$OUT/a.sse" | sed 's/event: //' | uniq -c | tr -s ' ' | tr '\n' ';')"
echo "   text: $(grep '"text_delta"' "$OUT/a.sse" | sed 's/^data: //' | jq -rj '.delta.text' | head -c 200)"

for model in gpt-6-astra gpt-6-luna; do
    echo "== B. tool loop on $model (non-stream so both legs can be inspected)"
    jq -n --arg m "$model" --argjson tools "$TOOLS" '{model:$m,max_tokens:500,system:"Use tools when asked.",tools:$tools,
        messages:[{role:"user",content:"Use the Read tool to read /etc/hostname, then tell me what it contains."}]}' > "$OUT/b1.$model.req"
    code=$(post "b1.$model" "$OUT/b1.$model.req")
    echo "   leg 1: HTTP $code stop=$(jq -r .stop_reason "$OUT/b1.$model.json") blocks=$(jq -c '[.content[]?.type]' "$OUT/b1.$model.json")"
    echo "          tool input=$(jq -c '[.content[]? | select(.type=="tool_use") | .input]' "$OUT/b1.$model.json")  signature=$(jq -r '[.content[]? | select(.type=="thinking") | .signature[0:12]] | join(",")' "$OUT/b1.$model.json")..."
    [ "$code" = 200 ] || { head -c 600 "$OUT/b1.$model.json"; echo; continue; }

    # Leg 2: echo the assistant turn back verbatim (as Claude Code does) plus the tool result.
    jq -n --arg m "$model" --argjson tools "$TOOLS" --slurpfile a "$OUT/b1.$model.json" '
        ($a[0].content) as $content |
        {model:$m,max_tokens:500,system:"Use tools when asked.",tools:$tools,messages:[
          {role:"user",content:"Use the Read tool to read /etc/hostname, then tell me what it contains."},
          {role:"assistant",content:$content},
          {role:"user",content:[ $content[] | select(.type=="tool_use") | {type:"tool_result",tool_use_id:.id,content:"     1\tclaudex-spike-host"} ]}]}' > "$OUT/b2.$model.req"
    code=$(post "b2.$model" "$OUT/b2.$model.req")
    echo "   leg 2: HTTP $code stop=$(jq -r .stop_reason "$OUT/b2.$model.json") text=$(jq -r '[.content[]? | select(.type=="text") | .text] | join(" ")' "$OUT/b2.$model.json" | head -c 200)"
    echo "          usage=$(jq -c .usage "$OUT/b2.$model.json")"
    [ "$code" = 200 ] || { head -c 600 "$OUT/b2.$model.json"; echo; }
done

echo "== proxy log (metadata only)"
sed 's/^/   /' "$OUT/spike1.proxy.log"
