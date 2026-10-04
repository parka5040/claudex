#!/usr/bin/env bash
# Exercises the native GPT Bash sandbox with a fake home and no credentials.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
W="$ROOT/plugin/bin/claudex-worker"
if [[ ! -x /usr/bin/bwrap && ! -x /bin/bwrap ]]; then
    printf 'UNVERIFIED: trusted bwrap not found\n'
    exit 0
fi
TMP="$(mktemp -d "${TMPDIR:-/tmp}/claudex-sbx-XXXXXX")" || { printf '    FAIL: cannot create sandbox test directory\n' >&2; exit 1; }
[[ -n "$TMP" && -d "$TMP" ]] || { printf '    FAIL: sandbox test directory is missing\n' >&2; exit 1; }
fails=0 checks=0
check() { checks=$((checks+1)); if [[ "$2" != "$3" ]]; then fails=$((fails+1)); printf '    FAIL: %s: got %q, want %q\n' "$1" "$2" "$3"; fi; }
contains() { checks=$((checks+1)); case "$2" in *"$3"*) ;; *) fails=$((fails+1)); printf '    FAIL: %s: %q not in %q\n' "$1" "$3" "${2:0:400}";; esac; }
export HOME="$TMP/home"
WORK="$HOME/work"
SERVER_PID='' ESCAPE_DIR='' PRIVATE_DIR=''
child_is_running() {
    local pid=$1 child running
    [[ -n "$pid" ]] || return 1
    running=$(jobs -pr)
    while IFS= read -r child; do
        [[ "$child" != "$pid" ]] || return 0
    done <<< "$running"
    return 1
}
stop_server() {
    if [[ -n "$SERVER_PID" ]]; then
        if child_is_running "$SERVER_PID"; then kill "$SERVER_PID" 2>/dev/null || true; fi
        wait "$SERVER_PID" 2>/dev/null || true
        SERVER_PID=''
    fi
}
cleanup() {
    stop_server
    if [[ -n "$ESCAPE_DIR" && -d "$ESCAPE_DIR" ]]; then
        rm -f -- "$ESCAPE_DIR/sentinel"
        rmdir -- "$ESCAPE_DIR" 2>/dev/null || true
    fi
    if [[ -n "$PRIVATE_DIR" && -d "$PRIVATE_DIR" ]]; then
        rm -f -- "$PRIVATE_DIR/sentinel"
        rmdir -- "$PRIVATE_DIR" 2>/dev/null || true
    fi
    rm -rf -- "$TMP"
}
trap cleanup EXIT
# This fixture must live on the read-only root, not beneath the private /tmp mount.
ESCAPE_DIR="$(mktemp -d /var/tmp/claudex-sbx-XXXXXX)" || { printf '    FAIL: cannot create read-only-root fixture\n' >&2; exit 1; }
[[ -n "$ESCAPE_DIR" && -d "$ESCAPE_DIR" ]] || { printf '    FAIL: read-only-root fixture is missing\n' >&2; exit 1; }
PRIVATE_DIR="$(mktemp -d "${TMP%/*}/claudex-sbx-private-XXXXXX")" || { printf '    FAIL: cannot create private-tmp fixture\n' >&2; exit 1; }
[[ -n "$PRIVATE_DIR" && -d "$PRIVATE_DIR" ]] || { printf '    FAIL: private-tmp fixture is missing\n' >&2; exit 1; }
mkdir -p "$WORK/sub" "$HOME/.local/bin" "$TMP/outside-dir" || exit 1
w() { /usr/bin/env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" "$@"; }
sbx() { w "$W" sandbox --cwd "$WORK" -c "$1"; }
quote() { printf '%q' "$1"; }

printf '  sandbox confines writes, hides home and /run, and binds toolchains read-only\n'
out=$(sbx 'printf inside > inside' 2> "$TMP/err"); rc=$?
check 'in-directory write exit (workspace beneath home)' "$rc" 0
check 'in-directory file content' "$(< "$WORK/inside")" inside
escape="$ESCAPE_DIR/sentinel"
printf original > "$escape"
out=$(sbx "printf outside > $(quote "$escape")" 2> "$TMP/err"); rc=$?
check 'write to read-only root fails' "$([[ "$rc" -ne 0 ]] && printf yes || printf no)" yes
check 'read-only root sentinel unchanged' "$(< "$escape")" original
out=$(sbx 'printf outside > "$HOME/outside"' 2> "$TMP/err"); rc=$?
check 'write to hidden home fails' "$([[ "$rc" -ne 0 ]] && printf yes || printf no)" yes
check 'hidden home write not visible outside' "$([[ -e "$HOME/outside" ]] && printf yes || printf no)" no
printf secret > "$HOME/secret"
out=$(sbx 'test ! -e "$HOME/secret"' 2> "$TMP/err"); rc=$?
check 'pre-existing home file hidden' "$rc" 0
printf toolchain > "$HOME/.local/bin/tool"
out=$(sbx 'cat "$HOME/.local/bin/tool"' 2> "$TMP/err"); rc=$?
check 'toolchain readable exit' "$rc" 0
check 'toolchain readable content' "$out" toolchain
out=$(sbx 'printf changed > "$HOME/.local/bin/tool"' 2> "$TMP/err"); rc=$?
check 'toolchain write fails' "$([[ "$rc" -ne 0 ]] && printf yes || printf no)" yes
check 'toolchain remains unchanged' "$(< "$HOME/.local/bin/tool")" toolchain
private="$PRIVATE_DIR/sentinel"
out=$(sbx "mkdir -p $(quote "$PRIVATE_DIR"); printf private > $(quote "$private"); test -f $(quote "$private")" 2> "$TMP/err"); rc=$?
check 'private tmp write exit' "$rc" 0
check 'private tmp file absent outside' "$([[ -e "$private" ]] && printf yes || printf no)" no
out=$(sbx 'ls -A /run' 2> "$TMP/err"); rc=$?
check '/run listing exit' "$rc" 0
check '/run is empty' "$out" ''

printf '  sandbox restores PATH only inside and never selects caller-PATH bwrap\n'
sandbox_path="$WORK/fakebin:/usr/bin:/bin"
out=$(w "$W" sandbox --cwd "$WORK" --path "$sandbox_path" -c 'printf %s "$PATH"' 2> "$TMP/err"); rc=$?
check '--path command exit' "$rc" 0
check '--path reaches command' "$out" "$sandbox_path"
out=$(sbx 'printf %s "$PATH"' 2> "$TMP/err"); rc=$?
check 'default PATH command exit' "$rc" 0
check 'default sandbox PATH' "$out" /usr/bin:/bin
fakepath="$WORK/fakebin"
mkdir -p "$fakepath" || exit 1
printf '%s\n' '#!/bin/bash' "printf executed > $(quote "$TMP/fake-bwrap-ran")" 'exit 1' > "$fakepath/bwrap"
chmod +x "$fakepath/bwrap"
out=$(w PATH="$fakepath:$PATH" "$W" sandbox --cwd "$WORK" -c 'true' 2> "$TMP/err"); rc=$?
check 'direct launch ignores fake bwrap' "$rc" 0
check 'direct launch did not execute fake bwrap' "$([[ -e "$TMP/fake-bwrap-ran" ]] && printf yes || printf no)" no
out=$(/usr/bin/env -i HOME="$HOME" PATH=/usr/bin:/bin /bin/bash "$W" sandbox --cwd "$WORK" --path "$fakepath:$PATH" -c 'true' 2> "$TMP/err"); rc=$?
check 'production launch ignores fake bwrap' "$rc" 0
check 'production launch did not execute fake bwrap' "$([[ -e "$TMP/fake-bwrap-ran" ]] && printf yes || printf no)" no

printf '  sandbox has no network, even to an owned outside loopback server\n'
token="${TMP##*/}:loopback"
printf %s "$token" > "$WORK/server-token"
python3 - "$WORK" "$TMP/server-port" <<'PY' > "$TMP/server.log" 2>&1 & SERVER_PID=$!
import functools
import http.server
import pathlib
import sys
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=sys.argv[1])
server = http.server.HTTPServer(('127.0.0.1', 0), handler)
pathlib.Path(sys.argv[2]).write_text(str(server.server_port))
server.serve_forever()
PY
ready=no
for ((i=0; i<50; i++)); do
    child_is_running "$SERVER_PID" || break
    if [[ -s "$TMP/server-port" ]]; then
        PORT=$(< "$TMP/server-port")
        response=$(curl --noproxy '*' -fsS -m 1 "http://127.0.0.1:$PORT/server-token" 2>/dev/null)
        if [[ "$response" == "$token" ]] && child_is_running "$SERVER_PID"; then ready=yes; break; fi
    fi
    sleep 0.1
done
check 'owned outside loopback server reachable with unique token' "$ready" yes
[[ "$ready" == yes ]] || exit 1
out=$(sbx "curl --noproxy '*' -fsS -m 2 http://127.0.0.1:$PORT/server-token" 2> "$TMP/err"); rc=$?
check 'sandbox cannot connect to outside server' "$([[ "$rc" -ne 0 ]] && printf yes || printf no)" yes
stop_server

printf '  sandbox preserves status, literal quoting, and in-tree caller cwd\n'
for status in 0 1 7 126; do
    out=$(sbx "exit $status" 2> "$TMP/err"); rc=$?
    check "command exit $status propagates" "$rc" "$status"
done
out=$(sbx "printf '%s' \"it's \\\$HOME\"" 2> "$TMP/err"); rc=$?
check 'quoting exit' "$rc" 0
check 'quoting literal content' "$out" "it's \$HOME"
out=$(cd "$WORK/sub" && sbx 'pwd' 2> "$TMP/err"); rc=$?
check 'inside caller cwd exit' "$rc" 0
check 'inside caller cwd kept' "$out" "$WORK/sub"
out=$(cd "$TMP" && sbx 'pwd' 2> "$TMP/err"); rc=$?
check 'outside caller cwd exit' "$rc" 0
check 'outside caller cwd becomes DIR' "$out" "$WORK"

printf '  resolve checks existing, missing, relative, and symlinked paths\n'
ln -s "$TMP/outside-dir" "$WORK/bridge" || exit 1
for path in "$WORK" "$WORK/inside" "$WORK/sub/../inside" "$WORK/missing" inside sub/../missing; do
    out=$(w "$W" resolve --cwd "$WORK" "$path" 2> "$TMP/err"); rc=$?
    check "resolve inside $path exit" "$rc" 0
    check "resolve inside $path is silent" "$out" ''
    check "resolve inside $path stderr empty" "$(< "$TMP/err")" ''
done
for path in "$TMP/outside-dir" "$WORK/.." "$WORK/bridge" "$WORK/bridge/missing" ../secret; do
    out=$(w "$W" resolve --cwd "$WORK" "$path" 2> "$TMP/err"); rc=$?
    check "resolve outside $path exit" "$rc" 3
    check "resolve outside $path stdout empty" "$out" ''
    contains "resolve outside $path diagnostic" "$(< "$TMP/err")" 'claudex: PATH resolves outside DIR'
done
for dir in relative "$TMP/missing" "$WORK/inside"; do
    out=$(w "$W" resolve --cwd "$dir" inside 2>&1); rc=$?
    check "resolve bad DIR $dir" "$rc" 2
done

printf '  sandbox refuses unsafe directories and empty commands\n'
for dir in relative "$TMP/missing" / "$TMP" "$TMP/.."; do
    out=$(w "$W" sandbox --cwd "$dir" -c 'true' 2>&1); rc=$?
    check "refuse directory $dir" "$rc" 2
done
out=$(sbx '' 2>&1); rc=$?
check 'refuse empty command' "$rc" 2
out=$(w CLAUDEX_BWRAP=/nonexistent "$W" sandbox --cwd "$WORK" -c "touch $(quote "$TMP/unsandboxed")" 2>&1); rc=$?
check 'missing bwrap exit' "$rc" 126
contains 'missing bwrap refusal' "$out" 'refusing to run unsandboxed'
check 'missing bwrap never runs command' "$([[ -e "$TMP/unsandboxed" ]] && printf yes || printf no)" no
printf '%s\n' '#!/bin/bash' 'exit 1' > "$TMP/setup-error"
chmod +x "$TMP/setup-error"
out=$(w CLAUDEX_BWRAP="$TMP/setup-error" "$W" sandbox --cwd "$WORK" -c "touch $(quote "$TMP/setup-marker")" 2>&1); rc=$?
check 'bwrap setup failure exit' "$rc" 126
contains 'bwrap setup failure refusal' "$out" 'refusing to run unsandboxed'
check 'bwrap setup failure never runs command' "$([[ -e "$TMP/setup-marker" ]] && printf yes || printf no)" no

printf '  %s checks, %s failures\n' "$checks" "$fails"
exit $((fails > 0))
