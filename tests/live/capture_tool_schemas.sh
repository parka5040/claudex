#!/usr/bin/env bash
# Capture only tool definitions via a disposable local Messages API server.
set -euo pipefail
scratch=$(mktemp -d "${TMPDIR:-/tmp}/claudex-schemas.XXXXXXXX") || exit 1
trap 'rm -rf -- "$scratch"' EXIT
python3 - "$scratch" <<'PY'
import json
import os
import socketserver
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler

wanted = {'Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'}
received = []
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        received.extend(tool for tool in body.get('tools', []) if tool.get('name') in wanted)
        reply = json.dumps({'id': 'msg_capture', 'type': 'message', 'role': 'assistant',
            'content': [{'type': 'text', 'text': 'captured'}], 'model': 'gpt-6-luna',
            'stop_reason': 'end_turn', 'stop_sequence': None,
            'usage': {'input_tokens': 1, 'output_tokens': 1}}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(reply)))
        self.end_headers()
        self.wfile.write(reply)

    def log_message(self, *args):
        pass

class Server(socketserver.TCPServer):
    allow_reuse_address = True

with Server(('127.0.0.1', 0), Handler) as server:
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    env = dict(os.environ, ANTHROPIC_BASE_URL=f'http://127.0.0.1:{server.server_address[1]}',
        ANTHROPIC_AUTH_TOKEN='not-a-real-token')
    try:
        result = subprocess.run(['claude', '-p', '--model', 'gpt-6-luna',
            '--tools', 'Read,Glob,Grep,Bash,Edit,Write', '--setting-sources', '',
            '--no-session-persistence', '--max-budget-usd', '0.01', 'Respond with captured.'],
            cwd=sys.argv[1], env=env, capture_output=True, text=True, timeout=55)
    finally:
        server.shutdown()
    if result.returncode != 0 or {tool['name'] for tool in received} != wanted:
        sys.exit(f'capture failed (exit {result.returncode}, tools {[t["name"] for t in received]}): {result.stderr[:400]}')
    print(json.dumps(received, indent=2))
PY
