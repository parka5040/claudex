#!/usr/bin/env bash
set -euo pipefail

if ! command -v claude >/dev/null 2>&1; then
    printf 'UNVERIFIED: claude not found\n'
    exit 0
fi

cd "$(dirname "$0")/../.."
if output=$(claude plugin validate plugin 2>&1); then
    :
else
    printf '%s\n' "$output"
    exit 1
fi

check_footprint() {
    local output=$1 line rest entry char depth hooks=0 calls=0
    local -a entries=()
    local -A expected=() seen=()
    for entry in \
        'session.start' \
        'tool.call{tool=mcp__claudex__review}' \
        'tool.call{tool=mcp__claudex__verdict}' \
        'tool.call{tool=Read}' \
        'tool.call{tool=Write}' \
        'tool.call{tool=Edit}' \
        'tool.call{tool=/"^Grep$"/}' \
        'tool.call{tool=/"^Glob$"/}' \
        'command.run{command=claudex}' \
        'ui.render{component=Pane,requestId=claudex-workers}' \
        'ui.render{component=Pane,requestId=claudex-findings}' \
        'turn.step' \
        'agent.spawn{subagentType=/"^claudex:gpt-"/}' \
        'agent.offer{agent=/"^claudex:gpt-"/}'; do
        expected["$entry"]=1
    done
    while IFS= read -r line; do
        [[ $line == *'❯ '* ]] || continue
        case "$line" in
            *' hooks: '*)
                ((hooks += 1))
                rest=${line#*' hooks: '}
                entries=()
                entry='' depth=0
                for ((i=0; i<${#rest}; i++)); do
                    char=${rest:i:1}
                    case $char in
                        '{') ((depth += 1)); entry+=$char ;;
                        '}') ((depth -= 1)); entry+=$char ;;
                        ',') if ((depth == 0)); then entries+=("$entry"); entry=''; else entry+=$char; fi ;;
                        *) entry+=$char ;;
                    esac
                    if ((depth < 0)); then printf 'malformed mod hook: %s\n' "$rest" >&2; return 1; fi
                done
                entries+=("$entry")
                if ((depth != 0)); then printf 'malformed mod hook: %s\n' "$rest" >&2; return 1; fi
                for entry in "${entries[@]}"; do
                    entry=${entry//[[:space:]]/}
                    if [[ ! ${expected[$entry]+yes} ]]; then printf 'unexpected mod hook: %s\n' "$entry" >&2; return 1; fi
                    if [[ ${seen[$entry]+yes} ]]; then printf 'duplicate mod hook: %s\n' "$entry" >&2; return 1; fi
                    seen["$entry"]=1
                done
                ;;
            *' calls: '*)
                ((calls += 1))
                rest=${line#*' calls: '}
                while [[ $rest == *' (via '* ]]; do
                    before=${rest%%' (via '*}
                    after=${rest#*' (via '}
                    rest=${before}${after#*)}
                done
                IFS=',' read -ra entries <<< "$rest"
                for entry in "${entries[@]}"; do
                    entry=${entry//[[:space:]]/}
                    case "$entry" in
                        '$.process.run'|'$.process.spawn'|'$.tool.register'|'$.tool.check'|'$.tool.list'|'$.command.register'|\
                        '$.session.id'|'$.session.messages'|'$.prompt.submit'|'$.agent.register'|'$.agent.list'|'$.ui.status'|'$.ui.toast'|\
                        '$.ui.open'|'$.ui.close'|'$.ui.resolve'|'$.ui.invalidate'|\
                        '$.clock.'*|'$.state.'*|'$.store.'*) ;;
                        *) printf 'unexpected mod call: %s\n' "$entry" >&2; return 1 ;;
                    esac
                done
                ;;
        esac
    done <<< "$output"
    if ((${#seen[@]} != ${#expected[@]} || hooks != 1 || calls == 0)); then
        printf 'missing hook or validation line: %d/%d hooks (%d lines), %d call lines\n' "${#seen[@]}" "${#expected[@]}" "$hooks" "$calls" >&2
        return 1
    fi
    return 0
}

if [[ ${1:-} == --self-test ]]; then
    check_footprint "$output" || exit 1
    for broken in \
        "${output/tool.call\{tool=Read\}, /}" \
        "${output/tool.call\{tool=Read\}/tool.call\{tool=Read\}, tool.call\{tool=Read\}}" \
        "${output/tool.call\{tool=Read\}/tool.call\{tool=outside\}}"; do
        if check_footprint "$broken" >/dev/null 2>&1; then
            printf 'invalid hook fixture was accepted\n' >&2
            exit 1
        fi
    done
    printf 'mod footprint negative fixtures: missing, duplicate, unexpected rejected\n'
    exit 0
fi

check_footprint "$output" || { printf '%s\n' "$output" >&2; exit 1; }
printf 'mod footprint: exact 14 hooks; capability allow-list satisfied; launch gates covered by plugin tests\n'
