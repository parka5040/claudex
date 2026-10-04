#!/usr/bin/env python3
"""Render a real 200x50 Claude Code PTY to timestamped pyte snapshots."""
import fcntl
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import termios
import time

import pyte

root = Path(__file__).resolve().parents[1]
cap = root / 'captures'
cap.mkdir(exist_ok=True)
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 200, 0, 0))

def attach_tty():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

proc = subprocess.Popen(
    ['claude', '--model', 'gpt-6-luna', '--plugin-dir', str(root / 'mod-b'),
     '--debug-file', str(cap / 'b-ui-debug.txt')],
    stdin=slave, stdout=slave, stderr=slave, preexec_fn=attach_tty,
)
os.close(slave)
screen = pyte.Screen(200, 50)
stream = pyte.Stream(screen)
start = time.monotonic()
started_at = time.time()
last_snapshot = -15
sent = False
expanded = False
trust_handled = False
trust_yes_seen = -1.0
trust_attempts = 0
last_trust_key = -10.0
completed = False
metadata = []
index = 0

try:
    while time.monotonic() - start < 125 and proc.poll() is None:
        elapsed = time.monotonic() - start
        ready, _, _ = select.select([master], [], [], 0.3)
        if ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            stream.feed(data.decode('utf-8', errors='replace'))
        rendered = '\n'.join(screen.display)
        trust_dialog = 'Accessing workspace:' in rendered and 'Yes, I trust this folder' in rendered
        if trust_dialog and '❯ Yes, I trust this folder' in rendered:
            if trust_yes_seen < 0:
                trust_yes_seen = elapsed
            if not trust_handled and elapsed - trust_yes_seen > 1:
                os.write(master, b'\r')
                trust_handled = True
                metadata.append(f't={elapsed:.1f} workspace trust: confirmed selected Yes')
        elif trust_dialog and not trust_handled and elapsed - last_trust_key > 3:
            keys = (b'\x1b[B', b'\t', b'j', b'\x1b[B')
            if trust_attempts < len(keys):
                os.write(master, keys[trust_attempts])
                trust_attempts += 1
                last_trust_key = elapsed
                metadata.append(f't={elapsed:.1f} workspace trust: navigation attempt {trust_attempts}')
        prompt_ready = 'Transcript saving is off' in rendered and '❯' in rendered
        if not sent and not trust_dialog and (prompt_ready or (trust_handled and '❯' in rendered and elapsed > 3)):
            os.write(master, b'Run the spikeb:shell agent and display its progress.\r')
            sent = True
            metadata.append(f't={elapsed:.1f} sent interactive prompt')
        if not expanded and sent and elapsed > 20 and (cap / 'b-started.txt').exists():
            os.write(master, b'\x0f')  # Ctrl+O expands the Agent row while it runs.
            expanded = True
            metadata.append(f't={elapsed:.1f} expanded running agent with Ctrl+O')
        if elapsed - last_snapshot >= 15:
            (cap / f'b-{index:02d}.txt').write_text(f't={elapsed:.1f}s; sent={sent}; returncode={proc.poll()}\n' + rendered + '\n')
            metadata.append(f't={elapsed:.1f} snapshot b-{index:02d}.txt progress={"SPIKEB-PROGRESS" in rendered} done={"SPIKEB-DONE" in rendered}')
            last_snapshot = elapsed
            index += 1
        done_file = cap / 'b-finally.txt'
        if ('SPIKEB-MAIN-DONE' in rendered and done_file.exists() and
                done_file.stat().st_mtime > started_at and
                time.time() - done_file.stat().st_mtime > 16 and not completed):
            completed = True
            metadata.append(f't={elapsed:.1f} agent finalizer and main response observed')
            time.sleep(4)
            (cap / f'b-{index:02d}.txt').write_text(f't={time.monotonic()-start:.1f}s; final\n' + '\n'.join(screen.display) + '\n')
            break
finally:
    if proc.poll() is None:
        os.killpg(proc.pid, signal.SIGINT)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=5)
    os.close(master)
    metadata.append(f'exit={proc.returncode}; sent={sent}; completed={completed}; trust_handled={trust_handled}')
    (cap / 'b-ui-metadata.txt').write_text('\n'.join(metadata) + '\n')
    print('\n'.join(metadata))
