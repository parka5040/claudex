#!/usr/bin/env bash
# Install claudex from an unpacked release (or a checkout) for the current user.
#
#   ./install.sh                 check prerequisites, build, install, register the plugin
#   ./install.sh --service       ... and also run the proxy as a per-user service (systemd/OpenRC)
#   ./install.sh --uninstall     remove everything install put in place (config and logs are kept)
#
# Nothing here needs root. Binaries go to ~/.local/bin; the plugin is copied to
# ~/.local/share/claudex so this directory can be deleted afterwards.

note() { printf '==> %s\n' "$*"; }
warn() { printf 'install.sh: warning: %s\n' "$*" >&2; }
die()  { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

usage() {
    printf '%s\n' \
        'Install claudex from an unpacked release (or a checkout) for the current user.' \
        '' \
        '  ./install.sh                 check prerequisites, build, install, register the plugin' \
        '  ./install.sh --service       ... and also run the proxy as a per-user service (systemd/OpenRC)' \
        '  ./install.sh --uninstall     remove everything install put in place (config and logs are kept)' \
        '' \
        'Nothing here needs root. Binaries go to ~/.local/bin; the plugin is copied to' \
        '~/.local/share/claudex so this directory can be deleted afterwards.'
    exit "${1:-0}"
}

uninstall_local() {
    note "removing claudex"
    make -C "$HERE" --no-print-directory uninstall PREFIX="$PREFIX" </dev/null
    rm -rf "$MARKETPLACE" "$DATA_DIR/kit" </dev/null
    rmdir "$DATA_DIR" </dev/null 2>/dev/null || true
    note "done"
}

prereqs() {
    note "checking prerequisites"
    [[ "$(uname -s </dev/null)" == Linux ]] || die "claudex needs Linux (the proxy confines itself with Landlock and seccomp)"

    local missing=() tool lib kver kmaj kmin
    for tool in make pkg-config "${CC:-gcc}" claude; do
        command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
    done
    if command -v pkg-config >/dev/null 2>&1; then
        for lib in libcurl yyjson libseccomp; do
            pkg-config --exists "$lib" </dev/null || missing+=("$lib (development files)")
        done
    fi
    if [[ ${#missing[@]} -gt 0 ]]; then
        printf 'install.sh: missing: %s\n' "${missing[@]}" >&2
        printf '%s\n' \
            '' \
            'Install the build dependencies with your package manager, for example:' \
            '  Arch / Artix:     sudo pacman -S --needed base-devel pkgconf curl yyjson libseccomp' \
            '  Debian / Ubuntu:  sudo apt install build-essential pkg-config libcurl4-openssl-dev libyyjson-dev libseccomp-dev' \
            '  Fedora:           sudo dnf install gcc make pkgconf-pkg-config libcurl-devel yyjson-devel libseccomp-devel' \
            'Claude Code itself: https://docs.claude.com/en/docs/claude-code' >&2
        exit 1
    fi

    # The proxy refuses to start without Landlock ABI 4 (TCP port rules, Linux 6.7+).
    kver="$(uname -r </dev/null)"; kmaj="${kver%%.*}"; kmin="${kver#*.}"; kmin="${kmin%%[!0-9]*}"
    if (( kmaj < 6 || (kmaj == 6 && kmin < 7) )); then
        warn "kernel $kver is older than 6.7; the proxy will refuse to start (needs Landlock ABI 4)"
    elif [[ -r /sys/kernel/security/lsm ]] && ! grep -q landlock /sys/kernel/security/lsm </dev/null; then
        warn "Landlock is not in the active LSM list ($(< /sys/kernel/security/lsm)); the proxy will refuse to start"
    fi

    if ! command -v codex >/dev/null 2>&1; then
        warn "the Codex CLI is not installed. claudex uses its ChatGPT login: install it and run 'codex login'"
    elif [[ ! -f "${CODEX_HOME:-$HOME/.codex}/auth.json" ]]; then
        warn "no Codex login found; run 'codex login' before using GPT workers"
    fi
}

install_local() {
    note "building"
    make -C "$HERE" --no-print-directory all </dev/null

    # Copy the plugin somewhere stable so the marketplace survives deleting this directory.
    note "copying the plugin to $MARKETPLACE"
    rm -rf "$MARKETPLACE" </dev/null
    mkdir -p "$MARKETPLACE" </dev/null
    cp -R "$HERE/.claude-plugin" "$HERE/plugin" "$MARKETPLACE/" </dev/null

    note "installing binaries to $PREFIX/bin and registering the plugin"
    make -C "$HERE" --no-print-directory install PREFIX="$PREFIX" MARKETPLACE="$MARKETPLACE" </dev/null

    # Keep what --uninstall needs, so it works after this directory is gone.
    local kit="$DATA_DIR/kit"
    rm -rf "$kit" </dev/null
    mkdir -p "$kit" </dev/null
    cp -R "$HERE/install.sh" "$HERE/Makefile" "$HERE/service" "$kit/" </dev/null

    if [[ $service -eq 1 ]]; then
        note "installing the per-user service"
        bash "$HERE/service/install.sh" install </dev/null
    fi

    case ":${PATH:-}:" in
        *":$PREFIX/bin:"*) ;;
        *) warn "$PREFIX/bin is not on your PATH; add it (e.g. in ~/.profile) so Claude Code can find claudex-worker" ;;
    esac

    printf '\n%s\n%s\n%s\n%s\n%s\n' \
        'claudex is installed. Check it with:  claudex-worker status' \
        'Then start a new Claude Code session and ask for a GPT worker, e.g. "have sol write the tests".' \
        "Uninstall with:                       $kit/install.sh --uninstall" \
        'Permission rules still worth adding to ~/.claude/settings.json permissions.allow:' \
        '  Bash(claudex-worker *), mcp__claudex__review, mcp__claudex__verdict'
}

local_main() {
    service=0
    local mode=install
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --service)   service=1 ;;
            --uninstall) mode=uninstall ;;
            -h|--help)   usage 0 ;;
            *) printf 'install.sh: unknown option: %s\n' "$1" >&2; usage 2 ;;
        esac
        shift
    done
    [[ $EUID -ne 0 ]] || die "run this as your own user, not root: the proxy reads your ~/.codex/auth.json"
    [[ -n ${HOME:-} ]] || die "HOME must be set"
    HERE="$(cd "$(dirname "${BASH_SOURCE[0]}" </dev/null)" && pwd)"
    PREFIX="${PREFIX:-$HOME/.local}"
    DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/claudex"
    MARKETPLACE="$DATA_DIR/marketplace"
    if [[ $mode == uninstall ]]; then
        uninstall_local
        return
    fi
    prereqs
    install_local
}

cleanup_bootstrap() {
    if [[ -n ${bootstrap_tmp:-} ]]; then
        rm -rf "$bootstrap_tmp" </dev/null
    fi
}

bootstrap() {
    [[ "$(uname -s </dev/null)" == Linux ]] || die "claudex needs Linux (the proxy confines itself with Landlock and seccomp)"
    local tool
    for tool in curl tar; do
        command -v "$tool" >/dev/null 2>&1 || die "missing: $tool"
    done

    local ref="${CLAUDEX_REF:-}" mode=install
    local args=()
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --ref)
                if [[ $# -lt 2 || -z ${2:-} || ${2:-} == -* ]]; then
                    printf 'install.sh: --ref requires a value\n' >&2
                    usage 2
                fi
                ref="$2"; shift ;;
            --service) args+=("$1") ;;
            --uninstall) mode=uninstall ;;
            -h|--help) usage 0 ;;
            *) printf 'install.sh: unknown option: %s\n' "$1" >&2; usage 2 ;;
        esac
        shift
    done
    [[ $EUID -ne 0 ]] || die "run this as your own user, not root: the proxy reads your ~/.codex/auth.json"
    [[ -n ${HOME:-} ]] || die "HOME must be set"

    if [[ $mode == uninstall ]]; then
        local kit="${XDG_DATA_HOME:-$HOME/.local/share}/claudex/kit/install.sh"
        [[ -f $kit ]] || die "claudex is not installed"
        bash "$kit" --uninstall </dev/null
        return
    fi

    local repo="${CLAUDEX_REPO:-parka5040/claudex}"
    local github="${CLAUDEX_GITHUB:-https://github.com/$repo}"
    local api="${CLAUDEX_GITHUB_API:-https://api.github.com/repos/$repo}"
    local proto='=https'
    if [[ -n ${CLAUDEX_GITHUB:-} || -n ${CLAUDEX_GITHUB_API:-} ]]; then
        proto='=https,http'
    fi
    if [[ -z $ref ]]; then
        local release
        if ! release="$(curl -fsSL --proto "$proto" --tlsv1.2 "$api/releases/latest" </dev/null)"; then
            die "no claudex release is published yet; pass --ref main to install the development branch"
        fi
        if [[ $release =~ \"tag_name\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
            ref="${BASH_REMATCH[1]}"
        else
            die "no claudex release is published yet; pass --ref main to install the development branch"
        fi
    fi

    bootstrap_tmp="$(mktemp -d "${TMPDIR:-/tmp}/claudex-install.XXXXXXXX" </dev/null)" || die "cannot create bootstrap directory"
    [[ -n $bootstrap_tmp && -d $bootstrap_tmp ]] || die "cannot create bootstrap directory"
    trap cleanup_bootstrap EXIT
    local archive="$bootstrap_tmp/source.tar.gz"
    curl -fsSL --proto "$proto" --tlsv1.2 "$github/archive/$ref.tar.gz" -o "$archive" </dev/null
    local unpack="$bootstrap_tmp/unpack"
    mkdir -p "$unpack" </dev/null
    tar -xzf "$archive" -C "$unpack" </dev/null
    shopt -s dotglob nullglob
    local entries=("$unpack"/*)
    shopt -u dotglob nullglob
    [[ ${#entries[@]} -eq 1 ]] || die "archive must contain exactly one top-level directory"
    [[ -d ${entries[0]} && ! -L ${entries[0]} ]] || die "archive must contain exactly one top-level directory"
    local tree="${entries[0]}"
    [[ -f $tree/install.sh && -f $tree/Makefile && -f $tree/plugin/.claude-plugin/plugin.json ]] || \
        die "archive is missing install.sh, Makefile or plugin/.claude-plugin/plugin.json"

    if [[ $ref =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$ ]]; then
        local manifest
        manifest="$(< "$tree/plugin/.claude-plugin/plugin.json")"
        if [[ $manifest =~ \"version\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
            if [[ ${BASH_REMATCH[1]} != "${ref#v}" ]]; then
                warn "release tag $ref differs from plugin version ${BASH_REMATCH[1]}"
            fi
        fi
    fi
    (cd "$tree" && bash ./install.sh "${args[@]}" </dev/null)
}

main() {
    set -euo pipefail
    local source="${BASH_SOURCE[0]:-}"
    if [[ -n $source && -f $source ]]; then
        local dir
        dir="$(dirname "$source" </dev/null)"
        if [[ -f $dir/Makefile ]]; then
            local_main "$@"
            return
        fi
    fi
    bootstrap "$@"
}

main "$@"
