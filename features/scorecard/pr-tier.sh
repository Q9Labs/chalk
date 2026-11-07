#!/usr/bin/env bash
# The pull request tier of the scorecard: build this job's scorecard from the reports the gate lanes wrote, compare it with
# the latest master run, and publish the table as the run summary and, on a pull request, as one sticky comment.
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
node features/scorecard/scorecard.mjs build "${flag}" "${report}" --tier pr --environment ci --region github-hosted --size ubuntu-24.04 --out "${scorecard}"

baseline=()
if [[ "${GITHUB_EVENT_NAME}" == "pull_request" ]]; then
  run_id="$(gh run list --repo "${GITHUB_REPOSITORY}" --workflow gate.yml --branch master --event push --status success --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
  # A missing baseline is expected on the first master run and after the artifact expires: the table then shows budgets only.
  if [[ -n "${run_id}" ]] && gh run download "${run_id}" --repo "${GITHUB_REPOSITORY}" --name "scorecard-${section}" --dir artifacts/baseline; then
    baseline=(--baseline "artifacts/baseline/scorecard-${section}.json")
  else
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
