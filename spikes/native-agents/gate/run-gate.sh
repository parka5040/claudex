#!/usr/bin/env bash
# Disposable verification driver. All repository artifacts stay in this gate.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAP="$ROOT/captures"
mkdir -p "$CAP"
export GATE_ROOT="$ROOT"
case "${1:-}" in
  item1|item1-skip)
    export GATE_CASE="$1" GATE_AGENT_MODEL="${GATE_AGENT_MODEL:-gpt-sol}"
    if [[ "$1" == item1-skip ]]; then export GATE_SKIP=1; fi
    mkdir -p "$CAP/work-item1"
    printf 'before: original\n' > "$CAP/work-item1/sample.txt"
    prompt="Call Agent once with subagent_type gate:gpt, description 'Verify GPT model guard', run_in_background false, and prompt 'Read $CAP/work-item1/sample.txt, use Bash pwd, edit before: original to after: gpt, then report.' Wait for the result. Do not call other tools."
    set +e
    env -u CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 \
      claude -p --plugin-dir "$ROOT/mod" --model gpt-6-luna --effort low \
      --output-format stream-json --verbose --max-turns 4 --max-budget-usd 1 \
      "$prompt" < /dev/null > "$CAP/$1-stream.jsonl" 2> "$CAP/$1-stderr.txt"
    rc=$?
    set -e
    printf 'nested_exit=%s\n' "$rc" | tee "$CAP/$1-status.txt"
    python3 - "$CAP/$1-stream.jsonl" <<'PY'
import json,sys
for line in open(sys.argv[1]):
    try: event=json.loads(line)
    except ValueError: continue
    if event.get('type') == 'assistant':
        print('assistant:', [(b.get('type'),b.get('name'),str(b.get('input',{}))[:220]) for b in event.get('message',{}).get('content',[])])
    elif event.get('type') == 'result': print('result:',event.get('subtype'),str(event.get('result',''))[:300])
PY
    ;;
  item2|item3|item4|panel|panel-v2|panel-v3|panel-v4|item1-ui)
    export GATE_CASE="$1" GATE_AGENT_MODEL="${GATE_AGENT_MODEL:-gpt-sol}"
    if [[ "$1" == item3 ]]; then export GATE_PACE_TEXT="${GATE_PACE_TEXT:-0.5}"; fi
    if [[ "$1" == item4 ]]; then export GATE_SIMULATE_OMISSION=1; fi
    for who in gpt control; do
      mkdir -p "$CAP/work-$who"
      printf 'before: original\n' > "$CAP/work-$who/sample.txt"
    done
    /tmp/claudex-spike-b-venv/bin/python "$ROOT/drive.py" "$1"
    ;;
  long|item5)
    export GATE_CASE="$1" GATE_AGENT_MODEL="${GATE_AGENT_MODEL:-gpt-6-sol}"
    mkdir -p "$CAP/work-long"
    prompt="Call Agent exactly once, foreground (run_in_background false), subagent_type gate:gpt, description 'Deep sol reasoning gate', prompt: 'Reason deeply about a plan to prove safety and liveness of a concurrent bounded work-queue with cancellation. Analyze lost wakeups, ABA, shutdown races, linearization points, adversarial schedules, and propose testable invariants; work through at least three counterexamples in detail and revise your design. Do not touch files. Give a thorough technical report.' Wait for its result and do not call any other tools."
    set +e
    env -u CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 \
      claude -p --plugin-dir "$ROOT/mod" --model gpt-6-luna --effort low \
      --output-format stream-json --verbose --max-turns 4 --max-budget-usd 2 \
      "$prompt" < /dev/null > "$CAP/$1-stream.jsonl" 2> "$CAP/$1-stderr.txt"
    rc=$?
    set -e
    printf 'nested_exit=%s\n' "$rc" | tee "$CAP/$1-status.txt"
    ;;
  *) printf 'usage: %s {item1|item1-skip|item1-ui|panel|long}\n' "$0" >&2; exit 2 ;;
esac
