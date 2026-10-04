#!/usr/bin/env bash
# Tests the piped installer against a loopback release server; installs nothing real.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INSTALL="$ROOT/install.sh"
if TMP="$(mktemp -d "${TMPDIR:-/tmp}/claudex-install-test.XXXXXX")" && [[ -n $TMP && -d $TMP ]]; then
    :
else
    printf '    FAIL: could not create a temporary test directory\n' >&2
    exit 1
fi
server_pid=
cleanup() {
    if [[ -n $server_pid ]]; then
        kill "$server_pid" 2>/dev/null || true
        wait "$server_pid" 2>/dev/null || true
    fi
    rm -rf "$TMP"
}
trap cleanup EXIT
fails=0 checks=0

check()    { checks=$((checks+1)); if [[ $2 != "$3" ]]; then fails=$((fails+1)); printf '    FAIL: %s: got <%s>, want <%s>\n' "$1" "$2" "$3"; fi; }
contains() { checks=$((checks+1)); if [[ $2 != *"$3"* ]]; then fails=$((fails+1)); printf '    FAIL: %s: <%s> not in: %s\n' "$1" "$3" "${2:0:400}"; fi; }

mkdir -p "$TMP/site/x/y/archive" "$TMP/site/repos/x/y/releases" \
    "$TMP/fixture/claudex-v9.9.9/plugin/.claude-plugin" "$TMP/home" "$TMP/prefix" \
    "$TMP/config" "$TMP/data" "$TMP/cache" "$TMP/state" "$TMP/scratch"
: > "$TMP/fixture/claudex-v9.9.9/Makefile"
printf '{"version": "9.9.9"}\n' > "$TMP/fixture/claudex-v9.9.9/plugin/.claude-plugin/plugin.json"
cat > "$TMP/fixture/claudex-v9.9.9/install.sh" <<'EOF'
#!/usr/bin/env bash
if [[ /dev/stdin -ef /dev/null ]]; then stdin=devnull; else stdin=other; fi
printf 'args=<%s> cwd=<%s> stdin=<%s>\n' "$*" "$PWD" "$stdin" >> "$STUB_LOG"
EOF
for ref in v9.9.9 main v1.0.0; do
    tar -czf "$TMP/site/x/y/archive/$ref.tar.gz" -C "$TMP/fixture" claudex-v9.9.9
done
printf '{"tag_name":"v9.9.9"}\n' > "$TMP/site/repos/x/y/releases/latest"
: > "$TMP/stub.log"

: > "$TMP/server.log"
python3 -u -m http.server --bind 127.0.0.1 --directory "$TMP/site" 0 > "$TMP/server.log" 2>&1 &
server_pid=$!
port=
for ((i=0; i<100; i++)); do
    if IFS= read -r line < "$TMP/server.log" && [[ $line =~ port[[:space:]]+([0-9]+) ]]; then
        port="${BASH_REMATCH[1]}"
        break
    fi
    if ! kill -0 "$server_pid" 2>/dev/null; then break; fi
    sleep 0.05
done
if [[ -z $port ]]; then
    printf '    FAIL: loopback server did not start:\n'
    while IFS= read -r line; do printf '%s\n' "$line"; done < "$TMP/server.log"
    exit 1
fi

run_bootstrap() {
    cat "$INSTALL" | env -i PATH="${PATH:-/usr/bin:/bin}" HOME="$TMP/home" PREFIX="$TMP/prefix" \
        TMPDIR="$TMP/scratch" XDG_CONFIG_HOME="$TMP/config" XDG_DATA_HOME="$TMP/data" \
        XDG_CACHE_HOME="$TMP/cache" XDG_STATE_HOME="$TMP/state" \
        CLAUDEX_GITHUB="http://127.0.0.1:$port/x/y" \
        CLAUDEX_GITHUB_API="http://127.0.0.1:$port/repos/x/y" \
        CLAUDEX_REPO=x/y STUB_LOG="$TMP/stub.log" bash -s -- "$@"
}
stub_count() {
    local line count=0
    while IFS= read -r line; do ((count+=1)); done < "$TMP/stub.log"
    printf '%s' "$count"
}
request_count() {
    local line count=0
    while IFS= read -r line; do [[ $line == *'GET '* ]] && ((count+=1)); done < "$TMP/server.log"
    printf '%s' "$count"
}
api_count() {
    local line count=0
    while IFS= read -r line; do [[ $line == *'GET /repos/x/y/releases/latest '* ]] && ((count+=1)); done < "$TMP/server.log"
    printf '%s' "$count"
}
home_count() {
    local files
    shopt -s nullglob dotglob
    files=("$TMP/home/"*)
    printf '%s' "${#files[@]}"
}

printf '  piped install uses the latest release and closes stdin\n'
out=$(run_bootstrap --service 2>&1); rc=$?
check 'piped install exit' "$rc" 0
check 'stub ran once' "$(stub_count)" 1
IFS= read -r entry < "$TMP/stub.log"
contains 'flag forwarded' "$entry" 'args=<--service>'
contains 'stub stdin is /dev/null' "$entry" 'stdin=<devnull>'
if [[ $entry =~ cwd=\<([^\>]*)\> ]]; then
    unpacked="${BASH_REMATCH[1]}"
    check 'stub ran inside unpacked tree' "${unpacked##*/}" claudex-v9.9.9
    check 'temporary extraction directory removed' "$([[ ! -e ${unpacked%/*} ]] && printf yes || printf no)" yes
else
    check 'stub logged its working directory' "$entry" 'cwd=<...>'
fi

printf '  explicit ref skips the releases API\n'
before=$(api_count)
out=$(run_bootstrap --ref main 2>&1); rc=$?
check 'explicit ref exit' "$rc" 0
check 'main archive requested' "$([[ $(< "$TMP/server.log") == *'GET /x/y/archive/main.tar.gz '* ]] && printf yes || printf no)" yes
check 'explicit ref skips API' "$(api_count)" "$before"
check 'explicit ref ran the stub' "$(stub_count)" 2

printf '  missing release fails rather than falling back\n'
rm "$TMP/site/repos/x/y/releases/latest"
out=$(run_bootstrap 2>&1); rc=$?
check 'no release exits non-zero' "$((rc != 0))" 1
contains 'no release explains --ref main' "$out" 'no claudex release is published yet; pass --ref main to install the development branch'
check 'no release never ran the stub' "$(stub_count)" 2

printf '  tag and manifest mismatch warns but installs\n'
run_bootstrap --ref v1.0.0 > "$TMP/out" 2> "$TMP/err"; rc=$?
check 'mismatch exit' "$rc" 0
contains 'mismatch warning on stderr' "$(< "$TMP/err")" 'warning:'
contains 'mismatch names the tag' "$(< "$TMP/err")" 'v1.0.0'
contains 'mismatch names the manifest version' "$(< "$TMP/err")" '9.9.9'
check 'mismatch still ran the stub' "$(stub_count)" 3

printf '  truncated pipe has no effects\n'
before=$(request_count)
bytes=$(wc -c < "$INSTALL")
head -c "$((bytes/2))" "$INSTALL" | env -i PATH="${PATH:-/usr/bin:/bin}" HOME="$TMP/home" \
    PREFIX="$TMP/prefix" TMPDIR="$TMP/scratch" XDG_DATA_HOME="$TMP/data" STUB_LOG="$TMP/stub.log" \
    CLAUDEX_GITHUB="http://127.0.0.1:$port/x/y" \
    CLAUDEX_GITHUB_API="http://127.0.0.1:$port/repos/x/y" bash -s -- > "$TMP/out" 2> "$TMP/err"
check 'truncated script never ran the stub' "$(stub_count)" 3
check 'truncated script made no requests' "$(request_count)" "$before"
check 'truncated script left HOME empty' "$(home_count)" 0

printf '  uninstall without a kit never downloads\n'
before=$(request_count)
out=$(run_bootstrap --uninstall 2>&1); rc=$?
check 'missing kit exits non-zero' "$((rc != 0))" 1
contains 'missing kit diagnostic' "$out" 'claudex is not installed'
check 'uninstall made no request' "$(request_count)" "$before"
check 'uninstall never ran the stub' "$(stub_count)" 3

printf '  local help and missing ref do not contact the server\n'
before=$(request_count)
out=$(bash "$INSTALL" --help </dev/null 2>&1); rc=$?
check 'local help exit' "$rc" 0
contains 'local help shows usage' "$out" './install.sh'
check 'local help made no request' "$(request_count)" "$before"
out=$(run_bootstrap --ref 2>&1); rc=$?
check 'missing ref exit code' "$rc" 2
contains 'missing ref is a usage error' "$out" '--ref requires a value'
check 'missing ref made no request' "$(request_count)" "$before"

printf '  %s checks, %s failures\n' "$checks" "$fails"
exit $((fails > 0))
