# The nightly Android and iOS publishers source this file. A cut is current when no newer cut has passed its proof.
# A newer cut that is red is held, so it is not production truth and does not make this build stale.
# Needs GITHUB_REPOSITORY, SOURCE_RUN (the cut's proof run id) and SOURCE_SHA.
cut_is_current() {
  gh api "repos/$GITHUB_REPOSITORY/deployments?environment=nightly&task=nightly-cut&per_page=30" |
    jq -e --arg run "$SOURCE_RUN" --arg sha "$SOURCE_SHA" \
      '[.[] | select(.payload.proof_result == "passed")][0] | .sha == $sha and .payload.proof_run_id == $run' >/dev/null
}
