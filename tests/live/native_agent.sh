#!/usr/bin/env bash
# Manual live regression check; NOT part of make check. Requires Claude Mods, a working
# claudex proxy/login, an interactive Claude Code login and Python pyte. Uses the real
# plugin and a native control (adapted from spikes/native-agents/gate/{run-gate.sh,
# drive.py,step.sh}). On Claude Code 2.1.302, inspect the captures: rows show types;
# /tasks shows the resolved GPT slug (e.g. gpt-6-luna (low)) beside the native model
# name; tool rows appear live in both views; the claudex status line shows 1 running
# while the GPT agent runs.
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
[[ -n $scratch && -d $scratch ]] || exit 1
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
phase = 'launch'
phase_since = 0.0
tasks_frame = ''
targets = ['claudex:gpt-luna', 'general-purpose']
target_index = moves = view_captures = 0

def selected():
    return next((l for l in screen.display if l.lstrip().startswith('❯ ●') or l.lstrip().startswith('❯ ◯')), '')

def advance(value):
    global phase, phase_since
    phase = value
    phase_since = time.monotonic() - start

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
    f'prompt "Run Bash `sleep 20` first, then Read {root}/sample.txt, run Bash pwd, Edit that file from before: original to after: gpt, then report. Only work in {root}." '
    'Second: subagent_type general-purpose, description Native control check (inherit the parent model), '
    f'prompt "Run Bash `sleep 20` first, then Read {root}/control.txt, run Bash pwd, Edit that file from before: original to after: control, then report. Only work in {root}." '
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
        if phase == 'launch' and sent and '↓ to manage' in rendered and (
                rendered.count('Backgrounded agent') >= 2 or '2 background agents' in rendered):
            key(b'/tasks', 'type /tasks after both agents launch')
            advance('tasks-command')
        elif phase == 'tasks-command' and elapsed - phase_since > 0.8:
            key(b'\r', 'show /tasks model labels')
            advance('tasks')
        elif phase == 'tasks' and elapsed - phase_since > 1.5 and (
                'running ·' in rendered or 'Background tasks' in rendered or 'Tasks' in rendered):
            tasks_frame = screenshot()
            (root / 'panel-tasks.txt').write_text(tasks_frame + '\n')
            key(b'\x1b', 'close /tasks')
            advance('selector-open')
        elif phase == 'selector-open' and elapsed - phase_since > 0.8:
            key(b'\x1b[B', f'open selector for {targets[target_index]}')
            moves = 0
            advance('selector')
        elif phase == 'selector' and elapsed - phase_since > 0.5:
            row = selected()
            if targets[target_index] in row:
                screenshot()
                key(b'\r', f'open {targets[target_index]} view')
                entered = True
                view_captures = 0
                advance('view')
            elif row:
                if moves >= 40:
                    raise SystemExit(f'cannot select {targets[target_index]}: {row}')
                key(b'\x1b[B', f'seek {targets[target_index]} from {row.strip()}')
                moves += 1
                phase_since = elapsed
        elif phase == 'view' and elapsed - last_capture >= 3:
            screenshot()
            view_captures += 1
            if view_captures >= 3:
                key(b'\x1b', f'leave {targets[target_index]} view')
                target_index += 1
                if target_index == len(targets):
                    advance('done')
                    break
                advance('selector-open')
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
    print('/tasks running rows:')
    for line in tasks_frame.splitlines():
        if 'running ·' in line:
            print(line.rstrip())
    if phase != 'done':
        raise SystemExit(f'live panel check incomplete ({phase}); inspect captures')
PY
