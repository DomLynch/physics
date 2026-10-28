#!/bin/bash
# physics-nightly.sh [target ...] : the nightly physics benchmark, run on the VPS (Hugging Face CPU jobs via hfjob). Installs nothing: no timer, no cron. Posting is scripts/nightly-post.mjs, run from a gh-authenticated host (the VPS gh is not logged in).
# Targets: physics-main (origin/main of DomLynch/physics), frankendom-v3 (the physics sha pinned in DomLynch/Frankendom-v3 package.json), armagedom (the sha pinned in DomLynch/ARMAGEDOM Web/package.json). Default: all three.
# Per target: clone the sha under /srv/dev-jobs/physics-nightly-<target>, run `hfjob -- <overlay + node tools/nightly.mjs>` there, wait, read NIGHTLY_JSON from `hfjob logs`, write
# /srv/dev-jobs/physics-nightly-results/<date>-<target>.json. The pin's src/ and data/bodies run with the CURRENT tools/ and data/{budget,nightly}-rows.json (fetched inside the job from NIGHTLY_TOOLS_REF, default main), so an old pin without admit()/loadChainBody()/tools/ still gives a result (those cells are skipped).
# No secret is read or printed here: hfjob reads the HF token inside itself. Public GitHub only (pins are read from raw.githubusercontent.com).
# Env: NIGHTLY_TOOLS_REF (branch or sha the tools come from, default main), NIGHTLY_ROOT (default /srv/dev-jobs), NIGHTLY_TIMEOUT (job, default 40m), NIGHTLY_WAIT (seconds to wait for a job, default 2400).
set -euo pipefail

PHYSICS=https://github.com/DomLynch/physics.git
ROOT=${NIGHTLY_ROOT:-/srv/dev-jobs}
RESULTS=$ROOT/physics-nightly-results
REF=${NIGHTLY_TOOLS_REF:-main}
JOBT=${NIGHTLY_TIMEOUT:-40m}
WAIT=${NIGHTLY_WAIT:-2400}
[[ "$ROOT" == /srv/dev-jobs* ]] || { echo "physics-nightly: NIGHTLY_ROOT must be under /srv/dev-jobs" >&2; exit 2; }
[[ "$REF" =~ ^[A-Za-z0-9_./-]+$ ]] || { echo "physics-nightly: bad NIGHTLY_TOOLS_REF" >&2; exit 2; }

# physics sha pinned by a game repo: the 40-hex in the @frankendom/physics tarball URL
pin() { # repo path
  curl -fsS "https://raw.githubusercontent.com/DomLynch/$1/main/$2" | grep -o 'DomLynch/physics/tar.gz/[0-9a-f]\{40\}' | head -1 | sed 's#.*/##'
}
resolve() {
  case "$1" in
    physics-main) git ls-remote "$PHYSICS" refs/heads/main | cut -f1 ;;
    frankendom-v3) pin Frankendom-v3 package.json ;;
    armagedom) pin ARMAGEDOM Web/package.json ;;
    *) echo "physics-nightly: unknown target '$1' (physics-main, frankendom-v3, armagedom)" >&2; return 2 ;;
  esac
}

one() {
  local target=$1 sha dir out id stage t0
  sha=$(resolve "$target")
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "physics-nightly: $target: no pinned sha found" >&2; return 1; }
  dir=$ROOT/physics-nightly-$target
  [ -d "$dir/.git" ] || git clone -q "$PHYSICS" "$dir"
  git -C "$dir" fetch -q origin "$sha" 2>/dev/null || git -C "$dir" fetch -q origin
  git -C "$dir" checkout -q --detach "$sha"
  echo "physics-nightly: $target at ${sha:0:9}"
  # inside the job: pull the current tools and rows over the pin, then run (no secret, public repo)
  local cmd="git fetch -q --depth 1 $PHYSICS $REF && git checkout FETCH_HEAD -- tools data/budget-rows.json data/nightly-rows.json && node tools/nightly.mjs --target $target --out /tmp/nightly.json"
  out=$(cd "$dir" && hfjob --timeout "$JOBT" -- bash -c "$cmd")
  id=$(printf '%s\n' "$out" | sed -n 's/.*job=\([0-9a-f]*\).*/\1/p' | head -1)
  [ -n "$id" ] || { echo "physics-nightly: $target: hfjob gave no job id: $out" >&2; return 1; }
  echo "physics-nightly: $target job=$id"
  t0=$(date +%s)
  while :; do
    stage=$(hfjob inspect "$id" | jq -r '.[0].status.stage')
    case "$stage" in COMPLETED|ERROR|CANCELED|DELETED) break ;; esac
    [ $(( $(date +%s) - t0 )) -lt "$WAIT" ] || { echo "physics-nightly: $target: job $id still $stage after ${WAIT}s" >&2; return 1; }
    sleep 20
  done
  [ "$stage" = COMPLETED ] || { echo "physics-nightly: $target: job $id ended $stage" >&2; return 1; }
  mkdir -p "$RESULTS"
  local line json date
  line=$(hfjob logs "$id" | grep -m1 '^NIGHTLY_JSON ' || true)
  [ -n "$line" ] || { echo "physics-nightly: $target: no NIGHTLY_JSON line in the job log ($id)" >&2; return 1; }
  json=${line#NIGHTLY_JSON }
  date=$(printf '%s' "$json" | jq -r '.date')
  printf '%s' "$json" | jq -e --arg t "$target" --arg s "$sha" '.schema=="nightly/1" and .target==$t and .sha==$s and (.cells|length>0)' >/dev/null \
    || { echo "physics-nightly: $target: result from job $id failed the schema/sha check" >&2; return 1; }
  printf '%s' "$json" | jq --arg id "$id" '. + {job: $id}' > "$RESULTS/$date-$target.json"
  echo "physics-nightly: $target -> $RESULTS/$date-$target.json ($(jq '.cells|length' "$RESULTS/$date-$target.json") cells, $(jq '.skipped|length' "$RESULTS/$date-$target.json") skipped)"
}

targets=("$@"); [ ${#targets[@]} -gt 0 ] || targets=(physics-main frankendom-v3 armagedom)
rc=0
for t in "${targets[@]}"; do one "$t" || rc=1; done   # one failing target does not stop the others
exit $rc
