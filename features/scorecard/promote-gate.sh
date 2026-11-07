#!/usr/bin/env bash
# The Promote tier of the scorecard: score the production proof of this Promote run against the median of the last seven
# nightly runs. The gate never changes the deploy: it only fails the Promote run, after the rollback decision is made.
# Usage: promote-gate.sh first|final <scorecard.json>   (run from the repository root)
#   first: score the first proof. A gated metric over budget writes over=true to GITHUB_OUTPUT, so the workflow reruns the proof once.
#          A non-empty SCORECARD_OVERRIDE records its reason and never blocks.
#   final: score the rerun. A gated metric still over budget fails the run and opens or updates the regression issue.
# Needs GH_TOKEN, GITHUB_REPOSITORY, GITHUB_STEP_SUMMARY, GITHUB_OUTPUT, GITHUB_RUN_ID, GITHUB_SERVER_URL.
set -euo pipefail

mode="${1:?usage: promote-gate.sh first|final <scorecard.json>}"
card="${2:?usage: promote-gate.sh first|final <scorecard.json>}"
override="${SCORECARD_OVERRIDE:-}"
scorecard="node features/scorecard/scorecard.mjs"
run_url="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

# The baseline is the nightly median of the card's media plane. Without history the table shows budgets only.
baseline=()
remote="${SCORECARD_HISTORY_REMOTE:-https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git}"
if git ls-remote --exit-code --heads "${remote}" scorecard-history > /dev/null 2>&1; then
  git clone --quiet --depth 1 --branch scorecard-history "${remote}" "${work}/history"
  plane="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).mediaPlane)' "${card}")"
  if ${scorecard} baseline --history "${work}/history" --plane "${plane}" --out "${work}/baseline.json" | grep -q '^Baseline'; then
    baseline=(--baseline "${work}/baseline.json" --baseline-label "the median of the last 7 nightly runs")
  fi
fi

over=0
${scorecard} diff --current "${card}" "${baseline[@]}" --title "Promote scorecard (${mode})" --markdown "${work}/table.md" --fail-on-gate || over=1
cat "${work}/table.md" >> "${GITHUB_STEP_SUMMARY}"

open_issue() {
  gh issue list --repo "${GITHUB_REPOSITORY}" --label scorecard-regression --state open --json number --jq '.[0].number // empty'
}

if [[ -n "${override}" ]]; then
  note="Scorecard override on ${run_url}: ${override}"
  printf '%s\n\n' "${note}" >> "${GITHUB_STEP_SUMMARY}"
  number="$(open_issue)"
  if [[ -n "${number}" ]]; then
    gh issue comment "${number}" --repo "${GITHUB_REPOSITORY}" --body "${note}"
  fi
  [[ "${mode}" == first ]] && echo "over=false" >> "${GITHUB_OUTPUT}"
  exit 0
fi

if [[ "${mode}" == first ]]; then
  if [[ "${over}" -eq 1 ]]; then
    echo "A gated metric is over its budget; the proof runs once more before the gate decides." >> "${GITHUB_STEP_SUMMARY}"
    echo "over=true" >> "${GITHUB_OUTPUT}"
  else
    echo "over=false" >> "${GITHUB_OUTPUT}"
  fi
  exit 0
fi

if [[ "${over}" -eq 0 ]]; then
  echo "The rerun is within every gated budget." >> "${GITHUB_STEP_SUMMARY}"
  exit 0
fi

{ echo "Promote ${run_url} found a gated metric over its budget twice."; echo; cat "${work}/table.md"; } > "${work}/issue.md"
number="$(open_issue)"
if [[ -n "${number}" ]]; then
  gh issue comment "${number}" --repo "${GITHUB_REPOSITORY}" --body-file "${work}/issue.md"
else
  gh label create scorecard-regression --repo "${GITHUB_REPOSITORY}" --color B60205 --description "A gated performance metric is over its budget" 2> /dev/null || true
  gh issue create --repo "${GITHUB_REPOSITORY}" --title "Scorecard regression" --label scorecard-regression --body-file "${work}/issue.md"
fi
echo "Scorecard gate: a gated metric is over its budget in the rerun. Rerun Promote with scorecard_override and a reason to accept it." >&2
exit 1
