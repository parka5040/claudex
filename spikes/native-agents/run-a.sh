#!/usr/bin/env bash
# Throwaway Spike A runner; writes repo artifacts only inside native-agents/.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SPIKEA_ROOT="$ROOT"
if [[ -z "${SPIKEA_DIR:-}" ]]; then
  SPIKEA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/claudex-spike-a-XXXXXXXX")" || { printf 'FAIL: cannot create spike directory\n' >&2; exit 1; }
fi
[[ -n "$SPIKEA_DIR" && -d "$SPIKEA_DIR" ]] || { printf 'FAIL: spike directory is missing\n' >&2; exit 1; }
export SPIKEA_DIR
mkdir -p "$ROOT/captures"
if [[ ! -f "$SPIKEA_DIR/sample.txt" ]]; then printf 'before: original\n' > "$SPIKEA_DIR/sample.txt"; fi
case "${1:-}" in
capture)
  # This fake endpoint saves ONLY tool definitions, never HTTP headers, credentials,
  # or other request fields. No real provider calls are made in this subcommand.
  SPIKEA_ROOT="$ROOT" python3 - <<'PY'
import json, os, socketserver, subprocess, threading
from http.server import BaseHTTPRequestHandler
from pathlib import Path

root = Path(os.environ['SPIKEA_ROOT'])
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        tools = [t for t in data.get('tools', []) if t.get('name') in ('Read','Glob','Grep','Bash','Edit','Write')]
        (root / 'tool-schemas-2.1.288.json').write_text(json.dumps(tools, indent=2) + '\n')
        print('Captured tool names:', [t['name'] for t in tools], flush=True)
        body = json.dumps({'id':'msg_spike_a','type':'message','role':'assistant','content':[{'type':'text','text':'captured'}],'model':'gpt-6-luna','stop_reason':'end_turn','stop_sequence':None,'usage':{'input_tokens':1,'output_tokens':1}}).encode()
        self.send_response(200)
        self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args): pass

class Server(socketserver.TCPServer): allow_reuse_address = True
with Server(('127.0.0.1', 0), Handler) as server:
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    env = dict(os.environ, ANTHROPIC_BASE_URL=f'http://127.0.0.1:{port}', ANTHROPIC_AUTH_TOKEN='not-a-real-token')
    # This special run uses a fake endpoint solely to inspect local tool schemas.
    cmd = ['claude','-p','--model','gpt-6-luna','--tools','Read,Glob,Grep,Bash,Edit,Write','--setting-sources','','--no-session-persistence','--max-budget-usd','0.01','Respond with captured.']
    try:
        proc = subprocess.run(cmd, env=env, cwd=os.environ['SPIKEA_DIR'], capture_output=True, text=True, timeout=55)
        print('Capture exit:',proc.returncode,'stdout:',proc.stdout[:400], 'stderr:',proc.stderr[:400])
    except subprocess.TimeoutExpired:
        print('Capture timed out')
    server.shutdown()
PY
  ;;
a)
  printf 'Spike dir: %s\n' "$SPIKEA_DIR"
  printf 'Session ID: %s\n' "${SPIKEA_SESSION_ID:-auto}"
  flags=()
  if [[ -n "${SPIKEA_MODE:-}" ]]; then flags+=(--permission-mode "$SPIKEA_MODE"); fi
  if [[ -n "${SPIKEA_SESSION_ID:-}" ]]; then flags+=(--session-id "$SPIKEA_SESSION_ID"); fi
  if [[ -n "${SPIKEA_ALLOW:-}" ]]; then flags+=(--allowedTools "$SPIKEA_ALLOW"); fi
  (cd "$SPIKEA_DIR" && claude -p --plugin-dir "$ROOT/mod-a" --model gpt-6-luna --effort low --max-budget-usd 0.75 --output-format stream-json --verbose "${flags[@]}" "Call the Agent tool exactly once with subagent_type spikea:gpt, description 'Read Bash Edit sample', and prompt: 'Read $SPIKEA_DIR/sample.txt using Read, run Bash command pwd, then Edit that same file to replace before: original with after: gpt. Report tool results and file contents. Only work within $SPIKEA_DIR.' Wait for the Agent result. Do not call any other tools.")
  printf '\nFile after run: '; python3 -c 'import os;print(open(os.environ["SPIKEA_DIR"]+"/sample.txt").read().strip())'
  ;;
ui-a)
  SPIKEA_VENV="$(mktemp -d "${TMPDIR:-/tmp}/claudex-spike-a-venv-XXXXXXXX")" || { printf 'FAIL: cannot create spike venv directory\n' >&2; exit 1; }
  [[ -n "$SPIKEA_VENV" && -d "$SPIKEA_VENV" ]] || { printf 'FAIL: spike venv directory is missing\n' >&2; exit 1; }
  trap '[[ -z "${SPIKEA_VENV:-}" || ! -d "$SPIKEA_VENV" ]] || rm -rf "$SPIKEA_VENV"' EXIT
  python3 -m venv "$SPIKEA_VENV"
  "$SPIKEA_VENV/bin/python" -m pip -q install pyte
  SPIKEA_UI=1 SPIKEA_ROOT="$ROOT" "$SPIKEA_VENV/bin/python" - <<'PY'
import os, pty, select, signal, struct, subprocess, termios, time
from pathlib import Path
import fcntl, pyte

root = Path(os.environ['SPIKEA_ROOT'])
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 200, 0, 0))
env = dict(os.environ, COLUMNS='200', LINES='50', TERM='xterm-256color')
proc = subprocess.Popen(['claude','--plugin-dir', str(root / 'mod-a'), '--model', 'gpt-6-luna', '--effort', 'low'], stdin=slave, stdout=slave, stderr=slave, env=env, cwd=env['SPIKEA_DIR'], start_new_session=True)
os.close(slave)
screen = pyte.Screen(200, 50)
stream = pyte.Stream(screen)
start = time.monotonic(); last = -20; sent = False; typed_at = None; dialogs = 0; last_dialog = -10; expanded = False; managed = False
while time.monotonic()-start < (55 if env.get('SPIKEA_CASE') == 'ui' else 85) and proc.poll() is None:
    readable,_,_ = select.select([master],[],[],0.5)
    if readable:
        try: data=os.read(master,65536)
        except OSError: break
        if not data: break
        stream.feed(data.decode('utf-8', 'replace'))
    elapsed = time.monotonic()-start
    text = '\n'.join(screen.display)
    if 'auto mode to no longer charge' in text and 'Enter to continue' in text and elapsed-last_dialog>4:
        os.write(master,b'\r'); dialogs += 1;last_dialog=elapsed
    if not sent and elapsed > 5:
        if 'Yes, I trust this folder' in text and elapsed-last_dialog>4:
            os.write(master,b'\x1b[B\r'); dialogs += 1;last_dialog=elapsed
        elif 'Choose' in text and ('theme' in text.lower() or 'terminal' in text.lower()) and elapsed-last_dialog>4:
            os.write(master,b'\r'); dialogs += 1;last_dialog=elapsed
        elif typed_at is None and 'Yes, I trust this folder' not in text and (elapsed > 13 or '❯' in text or '> ' in text):
            prompt = f"Call Agent exactly once with subagent_type spikea:gpt, description 'Read Bash Edit sample', and prompt: 'Read {env['SPIKEA_DIR']}/sample.txt using Read, run Bash command pwd, then Edit the file changing before: original to after: gpt. Report results. Only work inside {env['SPIKEA_DIR']}.' Wait for its result. Do not call other tools."
            os.write(master,prompt.encode()); typed_at = elapsed
        elif typed_at is not None and elapsed-typed_at>3:
            os.write(master,b'\r'); sent = True
    if sent and elapsed > 17 and not expanded and 'spikea:gpt(' in text:
        os.write(master,b'\x0f'); expanded = True
    if sent and elapsed > 20 and not managed and '↓ to manage' in text:
        os.write(master,b'\x1b[B'); managed = True
    if elapsed-last >= (4 if not sent else (4 if env.get('SPIKEA_CASE') == 'ui' else 10)):
        last=elapsed
        n = len(list((root / 'captures').glob('a-ui-*.txt'))) + 1
        (root/'captures'/f'a-ui-{n:02d}.txt').write_text(f'seconds={elapsed:.1f}; sent={sent}; dialogs={dialogs}\n'+text+'\n')
        print(f'snapshot {n}: {elapsed:.0f}s sent={sent} dialogs={dialogs}',flush=True)
    # Foreground and background subagents both get a full observation window.
n = len(list((root / 'captures').glob('a-ui-*.txt'))) + 1
(root/'captures'/f'a-ui-{n:02d}.txt').write_text(f'FINAL: seconds={time.monotonic()-start:.1f}; sent={sent}; dialogs={dialogs}; exit={proc.poll()}\n'+'\n'.join(screen.display)+'\n')
print(f'final snapshot {n}: exit={proc.poll()}',flush=True)
if proc.poll() is None: os.write(master, b'\x03')
time.sleep(1)
if proc.poll() is None: proc.send_signal(signal.SIGTERM)
try: proc.wait(timeout=5)
except subprocess.TimeoutExpired: proc.kill();proc.wait()
os.close(master)
print('UI session exit:',proc.returncode,'sent:',sent,'dialogs:',dialogs)
PY
  ;;
*) printf 'usage: %s {capture|a|ui-a}\n' "$0" >&2; exit 2;;
esac
