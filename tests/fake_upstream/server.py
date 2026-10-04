#!/usr/bin/env python3
"""Fake ChatGPT Codex backend for integration tests.

usage: server.py <port> <state-dir>
  <state-dir>/mode       read per request: text | tool | 401 | 429 | truncated | slow
  <state-dir>/requests   one JSON line per request: {"path", "headers", "body"}
Never talks to the network; binds 127.0.0.1 only.
"""
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1])
STATE = sys.argv[2]
FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fixtures")

TOOL_SSE = "".join(
    f"event: {json.loads(d)['type']}\ndata: {d}\n\n"
    for d in [
        '{"type":"response.created","response":{"id":"resp_tool"}}',
        '{"type":"response.output_item.added","output_index":0,"item":{"id":"rs_1","type":"reasoning","summary":[]}}',
        '{"type":"response.output_item.done","output_index":0,"item":{"id":"rs_1","type":"reasoning","summary":[],"encrypted_content":"ENCRYPTED"}}',
        '{"type":"response.output_item.added","output_index":1,"item":{"id":"fc_1","type":"function_call","call_id":"call_77","name":"Read","arguments":""}}',
        '{"type":"response.function_call_arguments.delta","output_index":1,"item_id":"fc_1","delta":"{\\"file_path\\":"}',
        '{"type":"response.function_call_arguments.delta","output_index":1,"item_id":"fc_1","delta":"\\"/tmp/a\\"}"}',
        '{"type":"response.output_item.done","output_index":1,"item":{"id":"fc_1","type":"function_call","call_id":"call_77","name":"Read","arguments":"{\\"file_path\\":\\"/tmp/a\\"}"}}',
        '{"type":"response.completed","response":{"id":"resp_tool","usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":60},"output_tokens":9,"output_tokens_details":{"reasoning_tokens":4},"total_tokens":109}}}',
    ]
)


def mode():
    try:
        with open(os.path.join(STATE, "mode")) as f:
            return f.read().strip()
    except OSError:
        return "text"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_POST(self):
        n = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(n).decode("utf-8", "replace")
        with open(os.path.join(STATE, "requests"), "a") as f:
            f.write(json.dumps({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body}) + "\n")

        m = mode()
        if m == "401":
            return self.send_json(401, {"error": {"message": "token expired", "code": "token_expired"}})
        if m == "429":
            return self.send_json(429, {"error": {"type": "usage_limit_reached", "message": "You've hit your usage limit.",
                                                   "plan_type": "pro", "resets_in_seconds": 1234}})
        if m == "tool":
            return self.send_sse(TOOL_SSE.encode())
        with open(os.path.join(FIXTURES, "text_simple.sse"), "rb") as f:
            data = f.read()
        if m == "truncated":
            data = data[: data.index(b"event: response.output_text.done")]
        self.send_sse(data, slow=(m == "slow"))

    def send_json(self, status, obj):
        raw = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.send_header("x-codex-primary-used-percent", "42")
        self.end_headers()
        self.wfile.write(raw)

    def send_sse(self, data, slow=False):
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("x-codex-primary-used-percent", "42")
        self.send_header("x-codex-active-limit", "codex")
        self.send_header("connection", "close")
        self.end_headers()
        step = 37 if slow else len(data)  # odd chunk size to split events mid-line
        for i in range(0, len(data), step):
            self.wfile.write(data[i:i + step])
            self.wfile.flush()
            if slow:
                time.sleep(0.002)
        self.close_connection = True


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
