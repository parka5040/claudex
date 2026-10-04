#!/usr/bin/env bash
# Tests service/install.sh with stub systemctl / rc-service / rc-update. Touches nothing real.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
I="$ROOT/service/install.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/claudex-st-XXXXXX")" && [ -n "$TMP" ] && [ -d "$TMP" ] || { printf '    FAIL: cannot create service test directory\n' >&2; exit 1; }
trap 'rm -rf "$TMP"' EXIT
fails=0 checks=0
check()    { checks=$((checks+1)); [ "$2" = "$3" ] || { fails=$((fails+1)); echo "    FAIL: $1: got '$2', want '$3'"; }; }
contains() { checks=$((checks+1)); case "$2" in *"$3"*) ;; *) fails=$((fails+1)); echo "    FAIL: $1: '$3' not in: ${2:0:300}";; esac; }

stub() { # stub <dir> <name> <exit-code>
    mkdir -p "$1"; printf '#!/usr/bin/env bash\necho "%s $*" >> "%s/calls"\nexit %s\n' "$2" "$TMP" "$3" > "$1/$2"; chmod +x "$1/$2"
}
run() { # run <stubdir> args...
    local d=$1; shift
    env -i HOME="$TMP/home" PATH="$d:/usr/bin:/bin" XDG_RUNTIME_DIR="$TMP/run" bash "$I" "$@" 2>&1
}
fresh() { rm -rf "$TMP/home" "$TMP/calls" "$TMP/sd" "$TMP/orc" "$TMP/none"; mkdir -p "$TMP/home/.local/bin" "$TMP/run"; : > "$TMP/calls"
          printf '#!/bin/sh\n' > "$TMP/home/.local/bin/claudex-worker"; chmod +x "$TMP/home/.local/bin/claudex-worker"; }

echo "  systemd"
fresh; stub "$TMP/sd" systemctl 0
out=$(run "$TMP/sd" install); check "install ok" "$?" "0"
unit="$TMP/home/.config/systemd/user/claudex-proxy.service"
check "unit installed" "$([ -f "$unit" ] && echo yes || echo no)" "yes"
contains "unit runs proxy-exec" "$(cat "$unit" 2>/dev/null)" "claudex-worker proxy-exec"
contains "daemon-reload" "$(cat "$TMP/calls")" "systemctl --user daemon-reload"
contains "enable --now" "$(cat "$TMP/calls")" "systemctl --user enable --now claudex-proxy.service"
: > "$TMP/calls"; out=$(run "$TMP/sd" uninstall); check "uninstall ok" "$?" "0"
contains "disable --now" "$(cat "$TMP/calls")" "systemctl --user disable --now claudex-proxy.service"
check "unit removed" "$([ -f "$unit" ] && echo yes || echo no)" "no"

echo "  openrc"
fresh; stub "$TMP/orc" rc-service 0; stub "$TMP/orc" rc-update 0
out=$(run "$TMP/orc" install); check "install ok" "$?" "0"
script="$TMP/home/.config/rc/init.d/claudex-proxy"
check "init script installed and executable" "$([ -x "$script" ] && echo yes || echo no)" "yes"
contains "script runs proxy-exec" "$(cat "$script" 2>/dev/null)" "proxy-exec"
contains "script is supervised" "$(cat "$script" 2>/dev/null)" "supervisor=supervise-daemon"
contains "added to default runlevel" "$(cat "$TMP/calls")" "rc-update --user add claudex-proxy default"
contains "started" "$(cat "$TMP/calls")" "rc-service --user claudex-proxy start"
: > "$TMP/calls"; out=$(run "$TMP/orc" uninstall); check "uninstall ok" "$?" "0"
contains "stopped" "$(cat "$TMP/calls")" "rc-service --user claudex-proxy stop"
contains "removed from runlevel" "$(cat "$TMP/calls")" "rc-update --user del claudex-proxy default"
check "script removed" "$([ -f "$script" ] && echo yes || echo no)" "no"

echo "  detection and errors"
fresh; stub "$TMP/sd" systemctl 0; stub "$TMP/sd" rc-service 0; stub "$TMP/sd" rc-update 0
out=$(run "$TMP/sd" install); contains "prefers systemd when its user manager answers" "$(cat "$TMP/calls")" "systemctl --user enable"
fresh; stub "$TMP/sd" systemctl 1; stub "$TMP/sd" rc-service 0; stub "$TMP/sd" rc-update 0
out=$(run "$TMP/sd" install); contains "falls back to openrc when systemctl --user fails" "$(cat "$TMP/calls")" "rc-update --user add"
fresh; stub "$TMP/sd" systemctl 0; stub "$TMP/sd" rc-service 0; stub "$TMP/sd" rc-update 0
out=$(run "$TMP/sd" install --init openrc); contains "--init overrides detection" "$(cat "$TMP/calls")" "rc-update --user add"
fresh; mkdir -p "$TMP/none"
out=$(run "$TMP/none" install); check "no supported init -> exit 1" "$?" "1"
fresh; stub "$TMP/sd" systemctl 0; rm -f "$TMP/home/.local/bin/claudex-worker"
out=$(run "$TMP/sd" install); check "worker not installed -> exit 1" "$?" "1"
contains "says to run make install" "$out" "make install"
out=$(run "$TMP/sd" frobnicate); check "bad verb -> exit 2" "$?" "2"

echo "  $checks checks, $fails failures"
exit $((fails > 0))
