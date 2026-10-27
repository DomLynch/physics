#!/bin/bash
# Run a command on a Hugging Face CPU job at a pushed commit of this repo (Strategy 2026-10-27: heavy runs go to HF CPU, the VPS only when HF refuses).
#   scripts/hf-job.sh <sha> -- <cmd...>
#   scripts/hf-job.sh 5aabc32 -- node --test 'test/*.test.mjs'
# Run it where the `hf` CLI is logged in (the VPS, as root: ssh -i ~/.ssh/binance_futures_tool root@49.12.7.18). It never reads or prints the token.
# The job (a node:22 container) clones this repo at <sha> (the commit must be pushed), runs `npm ci`, then <cmd>, and prints the job id (--detach).
#   hf jobs logs <id>        the output;  hf jobs inspect <id>  the state;  hf jobs cancel <id>
# Env: HF_JOB_FLAVOR (default cpu-upgrade), HF_JOB_TIMEOUT (default 30m), HF_JOB_REPO (default this repo's GitHub URL), HF_JOB_DRY=1 (print the hf command, run nothing).
# Not in the repo, so not on the job: the real body sources (/root/cut-out/*.source-plain.glb). Runs that need them (cut-units / cut-validate on Psyche and Minotaur) stay on the VPS.
set -euo pipefail

SHA="${1:-}"
[ -n "$SHA" ] || { echo "usage: $0 <sha> -- <cmd...>" >&2; exit 2; }
shift
[ "${1:-}" = "--" ] && shift
[ $# -ge 1 ] || { echo "usage: $0 <sha> -- <cmd...>  (no command given)" >&2; exit 2; }
case "$SHA" in
  *[!0-9a-f]*) echo "hf-job: <sha> must be a lowercase hex commit id, got '$SHA'" >&2; exit 2 ;;
esac
[ "${#SHA}" -ge 7 ] && [ "${#SHA}" -le 40 ] || { echo "hf-job: <sha> must be 7 to 40 hex characters" >&2; exit 2; }

REPO="${HF_JOB_REPO:-https://github.com/DomLynch/physics.git}"
FLAVOR="${HF_JOB_FLAVOR:-cpu-upgrade}"
TIMEOUT="${HF_JOB_TIMEOUT:-30m}"
CMD="$*"   # passed through the environment, so quotes in it need no escaping here

INNER='set -euo pipefail; git clone -q "$HF_JOB_REPO" /w && cd /w && git checkout -q "$HF_JOB_SHA" && echo "hf-job: at $(git rev-parse --short HEAD)" && npm ci --no-audit --no-fund >/dev/null && echo "hf-job: running: $HF_JOB_CMD" && bash -c "$HF_JOB_CMD"'

ARGS=(jobs run --detach --timeout "$TIMEOUT" --flavor "$FLAVOR" --label lane=physics --label "sha=$SHA"
  -e "HF_JOB_REPO=$REPO" -e "HF_JOB_SHA=$SHA" -e "HF_JOB_CMD=$CMD" node:22 bash -c "$INNER")

if [ "${HF_JOB_DRY:-}" = "1" ]; then printf 'hf'; printf ' %q' "${ARGS[@]}"; printf '\n'; exit 0; fi
exec hf "${ARGS[@]}"
