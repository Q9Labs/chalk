#!/usr/bin/env bash
# The pull request tier of the scorecard: build this job's scorecard from the reports the gate lanes wrote, compare it with
# the latest landed master run, and publish the table as the run summary and, on a pull request, as one sticky comment.
# Usage: pr-tier.sh web|sfu   (run from the repository root)
set -euo pipefail

section="${1:?usage: pr-tier.sh web|sfu}"
case "${section}" in
  web) report=artifacts/call-performance.json; flag=--web ;;
  sfu) report=artifacts/sfu-tests.json; flag=--sfu-tests ;;
  *) echo "unknown section ${section}" >&2; exit 2 ;;
esac
if [[ ! -s "${report}" ]]; then
  echo "No ${report}: this run did not select the ${section} lane."
  exit 0
fi

scorecard=artifacts/scorecard-${section}.json
node features/scorecard/scorecard.mjs build "${flag}" "${report}" --tier pr --environment ci --region github-hosted --size ubuntu-24-04 --out "${scorecard}"

baseline=()
if [[ "${GITHUB_EVENT_NAME}" == "pull_request" ]]; then
  # Master never runs the Gate on a push: every change lands through the merge queue, so the latest landed queue group is the master baseline.
  # A group that did not select this lane leaves no artifact, so walk back through the last few until one has it.
  # No baseline is expected on the first run and after the artifacts expire: the table then shows budgets only.
  for run_id in $(gh run list --repo "${GITHUB_REPOSITORY}" --workflow gate.yml --event merge_group --status success --limit 10 --json databaseId --jq '.[].databaseId'); do
    if gh run download "${run_id}" --repo "${GITHUB_REPOSITORY}" --name "scorecard-${section}" --dir artifacts/baseline 2>/dev/null; then
      baseline=(--baseline "artifacts/baseline/scorecard-${section}.json")
      break
    fi
  done
  if [[ ${#baseline[@]} -eq 0 ]]; then
    echo "No master baseline for ${section}; comparing with budgets only."
  fi
fi

table=artifacts/scorecard-${section}.md
status=0
node features/scorecard/scorecard.mjs diff --current "${scorecard}" "${baseline[@]}" --title "Scorecard: ${section}" --markdown "${table}" --fail-on-gate || status=$?
cat "${table}" >> "${GITHUB_STEP_SUMMARY}"
if [[ "${CAN_COMMENT:-false}" == "true" ]]; then
  node features/scorecard/scorecard.mjs comment --repo "${GITHUB_REPOSITORY}" --pr "${PR_NUMBER}" --section "${section}" --file "${table}"
fi
exit "${status}"
