#!/usr/bin/env bash
# Manual live regression check; NOT part of make check. Requires Claude Mods, a working
# claudex proxy/login, an interactive Claude Code login and Python pyte. Uses the real
# plugin and a native control (adapted from spikes/native-agents/gate/{run-gate.sh,
# drive.py,step.sh}). Inspect the printed captures: agent rows show types, tool rows
# appear live, and GPT text appears on step completion, not as it is streamed.
# Run: bash tests/live/native_agent.sh [headless|panel]
# Set CLAUDEX_LIVE_KEEP=1 to retain the disposable captures printed below.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
case "${1:-panel}" in headless|panel) case_name=${1:-panel} ;; *) printf 'usage: %s [headless|panel]\n' "$0" >&2; exit 2 ;; esac
command -v claude >/dev/null 2>&1 || { printf 'manual check needs claude\n' >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { printf 'manual check needs python3\n' >&2; exit 2; }
if [[ $case_name == panel ]]; then
    python3 -c 'import pyte' || { printf 'manual panel check needs Python pyte\n' >&2; exit 2; }
fi
scratch=$(mktemp -d "${TMPDIR:-/tmp}/claudex-native-agent.XXXXXXXX") || exit 1
cleanup() { [[ ${CLAUDEX_LIVE_KEEP:-0} == 1 ]] || rm -rf -- "$scratch"; }
trap cleanup EXIT
printf 'before: original\n' > "$scratch/sample.txt"
printf 'Capture directory: %s (set CLAUDEX_LIVE_KEEP=1 to retain)\n' "$scratch"
export CLAUDEX_LIVE_ROOT="$scratch" CLAUDEX_LIVE_PLUGIN="$repo/plugin"
if [[ $case_name == headless ]]; then
    prompt="Use Agent exactly once, foreground (run_in_background false), subagent_type claudex:gpt-luna, description 'GPT native check', prompt 'Read $scratch/sample.txt, run Bash pwd, Edit before: original to after: gpt in that file, then report.' Wait for its result. Do not do the task yourself."
    rc=0
    (cd "$scratch" && env -u CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 \
        claude -p --plugin-dir "$repo/plugin" --output-format stream-json --verbose \
        --max-turns 4 "$prompt" </dev/null > "$scratch/headless-stream.jsonl" 2> "$scratch/headless-stderr.txt") || rc=$?
    printf 'nested_exit=%s\n' "$rc"
    python3 - "$scratch/headless-stream.jsonl" <<'PY'
import json
import sys
for line in open(sys.argv[1]):
    try:
        event = json.loads(line)
    except ValueError:
        continue
    if event.get('type') == 'assistant':
        print('assistant:', [(block.get('type'), block.get('name')) for block in event.get('message', {}).get('content', [])])
    elif event.get('type') == 'result':
        print('result:', event.get('subtype'), str(event.get('result', ''))[:300])
PY
    printf 'scratch result: '; < "$scratch/sample.txt" python3 -c 'import sys; print(sys.stdin.read().strip())'
    exit "$rc"
fi
python3 - <<'PY'
import fcntl
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import termios
import time
import pyte

root = Path(os.environ['CLAUDEX_LIVE_ROOT'])
plugin = os.environ['CLAUDEX_LIVE_PLUGIN']
(root / 'control.txt').write_text('before: original\n')
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 200, 0, 0))
def attach_tty():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
env = dict(os.environ)
env.pop('CLAUDE_CODE_CHILD_SESSION', None)
env.update(CLAUDE_CODE_FORCE_SESSION_PERSISTENCE='1', COLUMNS='200', LINES='50', TERM='xterm-256color')
proc = subprocess.Popen(['claude', '--plugin-dir', plugin], stdin=slave, stdout=slave,
    stderr=slave, cwd=root, env=env, preexec_fn=attach_tty)
os.close(slave)
screen = pyte.Screen(200, 50)
stream = pyte.Stream(screen)
start = time.monotonic()
sent = entered = False
last_dialog = last_capture = -10.0
frame = 0
meta = []

def key(data, note):
    os.write(master, data)
    meta.append(f't={time.monotonic()-start:.1f} {note}')

def screenshot():
    global frame, last_capture
    elapsed = time.monotonic() - start
    rendered = '\n'.join(screen.display)
    rendered = re.sub(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', '<redacted-email>', rendered)
    rendered = re.sub(r'(?i)(bearer\s+|token["=: ]+)[A-Za-z0-9_./-]{20,}', '<redacted-token>', rendered)
    (root / f'panel-{frame:02}.txt').write_text(f't={elapsed:.1f} sent={sent} panelOpened={entered}\n{rendered}\n')
    frame += 1
    last_capture = elapsed
    return rendered

prompt = (
    'In this SAME response launch exactly TWO Agent calls in parallel, both run_in_background true, '
    'then stop. First: subagent_type claudex:gpt-luna, description GPT native check, '
    f'prompt "Read {root}/sample.txt, run Bash pwd, Edit that file from before: original to after: gpt, then report. Only work in {root}." '
    'Second: subagent_type general-purpose, description Native control check (inherit the parent model), '
    f'prompt "Read {root}/control.txt, run Bash pwd, Edit that file from before: original to after: control, then report. Only work in {root}." '
    'Do not do either task yourself.'
)
try:
    while proc.poll() is None and time.monotonic() - start < 180:
        ready, _, _ = select.select([master], [], [], 0.3)
        if ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            stream.feed(data.decode('utf-8', 'replace'))
        elapsed = time.monotonic() - start
        rendered = '\n'.join(screen.display)
        if 'hooks modules are turned off in this process' in rendered:
            meta.append(f't={elapsed:.1f} Claude Mods switched off; live check unavailable')
            break
        if 'auto mode to no longer charge' in rendered and 'Enter to continue' in rendered and elapsed - last_dialog > 3:
            key(b'\r', 'dismiss auto-mode information')
            last_dialog = elapsed
        elif 'Yes, I trust this folder' in rendered and not sent and elapsed - last_dialog > 3:
            key(b'\r' if '❯ Yes, I trust this folder' in rendered else b'\x1b[B\r', 'confirm workspace trust')
            last_dialog = elapsed
        elif not sent and elapsed > 8 and 'Yes, I trust this folder' not in rendered and 'Enter to continue' not in rendered and '❯' in rendered:
            key(prompt.encode(), 'type two-agent parent prompt')
            time.sleep(1.1)
            key(b'\r', 'send two-agent parent prompt')
            sent = True
        if sent and elapsed > 20 and not entered and '↓ to manage' in rendered:
            key(b'\x1b[B', 'open agent selector')
            entered = True
        if entered:
            for sec, sequence, desc in [(23, b'\x1b[B', 'select GPT agent'), (25, b'\r', 'open GPT view'),
                                        (65, b'\x1b', 'leave GPT view'), (67, b'\x1b[B', 'select control'),
                                        (69, b'\r', 'open control view')]:
                flag = f'did-{sec}'
                if elapsed > sec and not any(flag in event for event in meta):
                    key(sequence, f'{flag}: {desc}')
        if elapsed - last_capture >= 3:
            screenshot()
finally:
    screenshot()
    if proc.poll() is None:
        os.killpg(proc.pid, signal.SIGINT)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
    os.close(master)
    meta.append(f'exit={proc.returncode}; sent={sent}; panelOpened={entered}; frames={frame}')
    print('\n'.join(meta))
    print('GPT scratch:', (root / 'sample.txt').read_text().strip())
    print('Control scratch:', (root / 'control.txt').read_text().strip())
    if not sent or not entered:
        raise SystemExit('live panel check incomplete; inspect captures')
PY
