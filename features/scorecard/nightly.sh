#!/usr/bin/env bash
# The nightly tier of the scorecard: compare scorecards from a real-node run with the median of the last seven nightly runs,
# append them to the history branch, and keep one "scorecard regression" issue open while a gated metric is over its budget.
# Usage: nightly.sh <scorecard.json>...   (run from the repository root; needs GH_TOKEN, GITHUB_REPOSITORY, GITHUB_STEP_SUMMARY)
# With SCORECARD_KEEP_ISSUE=true it never closes the regression issue: the cut's cards hold no latency run, so only the latency workflow's full card may clear it.
# With SCORECARD_WARN_ONLY=true it only compares and appends to the history: it never opens, edits or closes the regression issue, and a history push that stays rejected after three tries exits 0.
set -euo pipefail

scorecard="node features/scorecard/scorecard.mjs"
# SCORECARD_HISTORY_REMOTE lets a test point the history at a local repository.
remote="${SCORECARD_HISTORY_REMOTE:-https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git}"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

# clone_history leaves a checkout of the history branch in ${work}/history, or an empty orphan branch before the first run.
clone_history() {
  rm -rf "${work}/history"
  if git ls-remote --exit-code --heads "${remote}" scorecard-history > /dev/null; then
    git clone --quiet --depth 1 --branch scorecard-history "${remote}" "${work}/history"
  else
    git init --quiet --initial-branch scorecard-history "${work}/history"
    git -C "${work}/history" remote add origin "${remote}"
  fi
  git -C "${work}/history" config user.name "github-actions[bot]"
  git -C "${work}/history" config user.email "41898282+github-actions[bot]@users.noreply.github.com"
}

clone_history
regressions=0
inconclusive=0
for card in "$@"; do
  if node -e 'const c=JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).contention; process.exit(c?.contended || c?.unobservable ? 0 : 1)' "${card}"; then
    inconclusive=1
  fi
  plane="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).mediaPlane)' "${card}")"
  baseline=()
  if ${scorecard} baseline --history "${work}/history" --plane "${plane}" --out "${work}/baseline-${plane}.json" | grep -q '^Baseline'; then
    baseline=(--baseline "${work}/baseline-${plane}.json" --baseline-label "the median of the last 7 nightly runs")
  fi
  status=0
  ${scorecard} diff --current "${card}" "${baseline[@]}" --title "Nightly scorecard: ${plane}" --markdown "${work}/table-${plane}.md" --fail-on-gate || status=$?
  cat "${work}/table-${plane}.md" >> "${GITHUB_STEP_SUMMARY}"
  if [[ "${status}" -ne 0 ]]; then
    regressions=1
    cat "${work}/table-${plane}.md" >> "${work}/regression.md"
  fi
done

# Appending is idempotent, so a lost push race is retried from a fresh clone.
for attempt in 1 2 3; do
  ${scorecard} append --history "${work}/history" "$@"
  git -C "${work}/history" add history.jsonl TRENDS.md
  git -C "${work}/history" commit --quiet -m "Nightly scorecard ${GITHUB_RUN_ID:-local}" || break
  git -C "${work}/history" push --quiet origin scorecard-history && break
  if [[ "${attempt}" -eq 3 ]]; then
    echo "Could not push the scorecard history." >&2
    [[ "${SCORECARD_WARN_ONLY:-}" == true ]] && exit 0
    exit 1
  fi
  clone_history
done

if [[ "${SCORECARD_WARN_ONLY:-}" == true ]]; then
  exit 0
fi

number="$(gh issue list --repo "${GITHUB_REPOSITORY}" --label scorecard-regression --state open --json number --jq '.[0].number // empty')"
if [[ "${regressions}" -eq 1 ]]; then
  run_url="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
  { echo "A gated metric is over its budget in a nightly run: ${run_url}"; echo; cat "${work}/regression.md"; } > "${work}/issue.md"
  if [[ -n "${number}" ]]; then
    gh issue edit "${number}" --repo "${GITHUB_REPOSITORY}" --body-file "${work}/issue.md"
  else
    gh label create scorecard-regression --repo "${GITHUB_REPOSITORY}" --color B60205 --description "A gated performance metric is over its budget" 2> /dev/null || true
    gh issue create --repo "${GITHUB_REPOSITORY}" --title "Scorecard regression" --label scorecard-regression --body-file "${work}/issue.md"
  fi
elif [[ -n "${number}" && "${inconclusive}" -eq 0 && "${SCORECARD_KEEP_ISSUE:-}" != true ]]; then
  gh issue close "${number}" --repo "${GITHUB_REPOSITORY}" --comment "The latest nightly run has no gated metric over its budget."
fi
exit "${regressions}"
