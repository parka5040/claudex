#!/usr/bin/env bash
set -euo pipefail
mode=$1 pidfile=$2
printf '%s\n' "$$" > "$pidfile"
if [[ "$mode" == short ]]; then
    for i in 0 1 2 3 4; do
        printf 'SPIKEB-PROGRESS step=%s elapsed=%ss\n' "$i" "$((i * 15))"
        [[ "$i" == 4 ]] || sleep 15
    done
else
    for i in 0 1 2 3 4; do
        printf 'SPIKEB-PROGRESS step=%s elapsed=%ss\n' "$i" "$((i * 15))"
        sleep 15
    done
    # The gap is 75 s after the last line (at t=60): 15 s above plus 60 here.
    sleep 60
    for i in 9 10 11 12 13 14 15; do
        printf 'SPIKEB-PROGRESS step=%s elapsed=%ss\n' "$i" "$((i * 15))"
        [[ "$i" == 15 ]] || sleep 15
    done
fi
printf 'SPIKEB-DONE mode=%s\n' "$mode"
