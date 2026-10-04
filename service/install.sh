#!/usr/bin/env bash
# Install / remove the claudex proxy as a per-user service under systemd or OpenRC.
# usage: install.sh install|uninstall|status [--init systemd|openrc]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
WORKER="$HOME/.local/bin/claudex-worker"
UNIT="$CONFIG_HOME/systemd/user/claudex-proxy.service"
RC_SCRIPT="$CONFIG_HOME/rc/init.d/claudex-proxy"

die() { local code=$1; shift; echo "claudex service: $*" >&2; exit "$code"; }

detect_init() {
    if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
        echo systemd
    elif command -v rc-service >/dev/null 2>&1 && command -v rc-update >/dev/null 2>&1 \
         && rc-service --user --list >/dev/null 2>&1; then
        echo openrc
    else
        return 1
    fi
}

verb="${1:-}"; [[ $# -gt 0 ]] && shift
init=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --init) init="${2:?}"; shift 2 ;;
        *) die 2 "unknown option: $1" ;;
    esac
done
case "$verb" in install|uninstall|status) ;; *) die 2 "usage: install.sh install|uninstall|status [--init systemd|openrc]" ;; esac
[[ -n "$init" ]] || init=$(detect_init) || die 1 "no supported per-user service manager found (need 'systemctl --user' or OpenRC >= 0.60 'rc-service --user'). The proxy still starts on demand without a service."
case "$init" in systemd|openrc) ;; *) die 2 "--init must be systemd or openrc" ;; esac

case "$verb:$init" in
install:*)
    [[ -x "$WORKER" ]] || die 1 "$WORKER is not installed; run 'make install' in the claudex repo first"
    ;;&
install:systemd)
    install -Dm644 "$HERE/claudex-proxy.service" "$UNIT"
    systemctl --user daemon-reload
    systemctl --user enable --now claudex-proxy.service
    echo "installed $UNIT (enabled and started). Logs: journalctl --user -u claudex-proxy"
    echo "to keep it running while logged out: loginctl enable-linger ${USER:-$(id -un)}"
    ;;
install:openrc)
    install -Dm755 "$HERE/claudex-proxy.openrc" "$RC_SCRIPT"
    rc-update --user add claudex-proxy default
    rc-service --user claudex-proxy start
    echo "installed $RC_SCRIPT (added to the default user runlevel and started). Logs: ~/.local/state/claudex/proxy.log"
    ;;
uninstall:systemd)
    systemctl --user disable --now claudex-proxy.service || true
    rm -f "$UNIT"
    systemctl --user daemon-reload || true
    echo "removed $UNIT. The proxy goes back to starting on demand."
    ;;
uninstall:openrc)
    rc-service --user claudex-proxy stop || true
    rc-update --user del claudex-proxy default || true
    rm -f "$RC_SCRIPT"
    echo "removed $RC_SCRIPT. The proxy goes back to starting on demand."
    ;;
status:systemd) systemctl --user status claudex-proxy.service --no-pager || true ;;
status:openrc)  rc-service --user claudex-proxy status || true ;;
esac
