#!/usr/bin/env python3
"""200x50 PTY/pyte driver; renders the actual agent panel at timed intervals."""
import fcntl
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

import pyte

root = Path(__file__).resolve().parent
cap = root / 'captures'
case = sys.argv[1]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 200, 0, 0))

def attach_tty():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

env = dict(os.environ)
env.pop('CLAUDE_CODE_CHILD_SESSION', None)
env['CLAUDE_CODE_FORCE_SESSION_PERSISTENCE'] = '1'
env.update(COLUMNS='200', LINES='50', TERM='xterm-256color')
proc = subprocess.Popen(
    ['env', '-u', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1',
     'claude', '--plugin-dir', str(root / 'mod'), '--model', 'gpt-6-luna', '--effort', 'low'],
    stdin=slave, stdout=slave, stderr=slave, cwd=root, env=env, preexec_fn=attach_tty,
)
os.close(slave)
screen = pyte.Screen(200, 50)
stream = pyte.Stream(screen)
start = time.monotonic()
sent = False
entered = False
last_dialog = -10.0
last_capture = -10.0
frame = 0
meta = []

def key(data, note):
    os.write(master, data)
    meta.append(f't={time.monotonic()-start:.1f} {note}')

def screenshot(rendered):
    global frame, last_capture
    elapsed = time.monotonic()-start
    # The UI itself should contain only task text. Never persist an email address or a bearer-like value.
    rendered = re.sub(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', '<redacted-email>', rendered)
    rendered = re.sub(r'(?i)(bearer\s+|token["=: ]+)[A-Za-z0-9_./-]{20,}', '<redacted-token>', rendered)
    (cap / f'{case}-{frame:02}.txt').write_text(f't={elapsed:.1f} sent={sent} panelOpened={entered} exit={proc.poll()}\n{rendered}\n')
    frame += 1
    last_capture = elapsed

prompt = (
    'In this SAME response launch exactly TWO Agent calls in parallel, both run_in_background true, '
    'then stop. First: subagent_type gate:gpt, description GPT scratch task, '
    f'prompt "Read {cap}/work-gpt/sample.txt, run Bash pwd, Edit that file from before: original to after: gpt, then report. Only work in {cap}/work-gpt." '
    'Second: subagent_type general-purpose, description Native control scratch task (do not specify a model; inherit the parent gpt-6-luna), '
    f'prompt "Read {cap}/work-control/sample.txt, run Bash pwd, Edit that file from before: original to after: control, then report. Only work in {cap}/work-control." '
    'Do not do either task yourself.'
)
try:
    while proc.poll() is None and time.monotonic()-start < 108:
        ready, _, _ = select.select([master], [], [], 0.3)
        if ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            stream.feed(data.decode('utf-8', 'replace'))
        elapsed = time.monotonic()-start
        rendered = '\n'.join(screen.display)
        if 'hooks modules are turned off in this process' in rendered:
            meta.append(f't={elapsed:.1f} hooks modules are turned off in this process; stopping')
            screenshot(rendered)
            break
        if 'auto mode to no longer charge' in rendered and 'Enter to continue' in rendered and elapsed-last_dialog > 3:
            key(b'\r', 'dismiss auto-mode information')
            last_dialog = elapsed
        elif 'Yes, I trust this folder' in rendered and not sent and elapsed-last_dialog > 3:
            if '❯ Yes, I trust this folder' in rendered:
                key(b'\r', 'confirm selected workspace trust')
            else:
                key(b'\x1b[B\r', 'select and confirm workspace trust')
            last_dialog = elapsed
        elif not sent and elapsed > 8 and 'Yes, I trust this folder' not in rendered and 'Enter to continue' not in rendered and '❯' in rendered:
            key(prompt.encode('utf-8'), 'type two-agent parent prompt')
            time.sleep(1.1)
            key(b'\r', 'send two-agent parent prompt')
            sent = True
        if sent and elapsed > 20 and not entered and '↓ to manage' in rendered:
            key(b'\x1b[B', 'open inline agent selector with down arrow')
            entered = True
        if elapsed - last_capture >= 3:
            screenshot(rendered)
        if entered and elapsed > 22:
            if case in ('panel-v4', 'item3', 'item4'):
                schedule = [(23, b'\x1b[B', 'select GPT agent'), (25, b'\x1b[B', 'select control agent'),
                            (27, b'\r', 'open control agent view'), (43, b'\x1b[A', 'select GPT agent'),
                            (45, b'\r', 'open GPT agent view'), (82, b'\x1b[B', 'select control after completion'),
                            (84, b'\r', 'open control after completion')]
            else:
                schedule = [(27, b'\x1b[B', 'select GPT agent'), (29, b'\r', 'open GPT agent view'),
                            (47, b'\x1b', 'leave GPT agent view'), (49, b'\x1b[B', 'select control agent'),
                            (51, b'\r', 'open control agent view'), (72, b'\x1b', 'leave control view'),
                            (74, b'\x1b[B', 'reopen agent list'), (76, b'\x1b[B', 'select agent'),
                            (78, b'\r', 'open agent after completion')]
            for sec, sequence, desc in schedule:
                flag = f'did-{sec}'
                if elapsed > sec and not any(flag in event for event in meta):
                    key(sequence, f'{flag}: {desc}')
finally:
    screenshot('\n'.join(screen.display))
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
    (cap / f'{case}-metadata.txt').write_text('\n'.join(meta)+'\n')
    print('\n'.join(meta))
