#!/usr/bin/env bash
# Only SSE JSON payloads go to stdout; never inspect or log HTTP headers.
set -euo pipefail
curl -sS -N --fail-with-body --max-time 540 \
  -H 'Content-Type: application/json' \
  --data-binary @- http://127.0.0.1:18765/v1/messages |
  python3 -u -c 'import json, os, sys, time
pace = float(os.environ.get("GATE_PACE_TEXT", "0"))
for line in sys.stdin:
    if line.startswith("data: "):
        value = line[6:].strip()
        if value and value != "[DONE]":
            if pace and json.loads(value).get("delta", {}).get("type") == "text_delta":
                time.sleep(pace)
            print(value, flush=True)
'
