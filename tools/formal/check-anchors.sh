# Shared code-fragment checks for the formal model runners.
fail() { echo "FAIL $*"; failures=$((failures + 1)); }
squash() { tr -s '[:space:]' ' '; }
check_formal_anchors() {
  local repo="$1"
  local anchors="$2"
  echo "== Code anchors"
  while IFS=$'\t' read -r action path fragment; do
    [[ -z "$action" || "$action" == \#* ]] && continue
    if [[ ! -f "$repo/$path" ]]; then
      fail "$action: $path is gone"
    elif ! squash <"$repo/$path" | grep -qF -- "$(printf '%s' "$fragment" | squash)"; then
      fail "$action: $path no longer contains: $fragment"
    fi
  done <"$anchors"
  ((failures == 0)) && echo "ok   every fragment in anchors is present"
  return 0
}
