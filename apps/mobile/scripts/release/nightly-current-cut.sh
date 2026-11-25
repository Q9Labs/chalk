# The nightly Android and iOS publishers source this file. A cut is current when no newer cut has passed its proof.
# A newer cut that is red is held, so it is not production truth and does not make this build stale.
# Needs GITHUB_REPOSITORY, SOURCE_RUN (the cut's proof run id) and SOURCE_SHA.
current_cut_sha_for_run() {
  gh api "repos/$GITHUB_REPOSITORY/deployments?environment=nightly&per_page=100" |
    jq -r --arg run "$SOURCE_RUN" \
      '[.[] | select(.task == "nightly-cut")][0] | select(.payload.proof_run_id == $run and .payload.proof_result == "passed") | .sha // empty'
}

cut_is_current() {
  gh api "repos/$GITHUB_REPOSITORY/deployments?environment=nightly&per_page=100" |
    jq -e --arg run "$SOURCE_RUN" --arg sha "$SOURCE_SHA" \
      '[.[] | select(.task == "nightly-cut" and .payload.proof_result == "passed")][0] | .sha == $sha and .payload.proof_run_id == $run' >/dev/null
}
