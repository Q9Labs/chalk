#!/usr/bin/env bash
set -euo pipefail

filter="${1:-}"
cache_dir="${HOME}/.cache"
cache_file="${cache_dir}/chalk-mobile-wireless-adb-last-endpoint"

mkdir -p "$cache_dir"

if [[ -n "$filter" && "$filter" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+$ ]]; then
  adb connect "$filter" >/dev/null
  printf '%s\n' "$filter" > "$cache_file"
  echo "$filter"
  adb devices -l
  exit 0
fi

lines=()
while IFS= read -r line; do
  [[ -n "$line" ]] && lines+=("$line")
done < <(adb mdns services 2>/dev/null | awk '/_adb-tls-connect\._tcp/ {print $3}')

target=""
if [[ ${#lines[@]} -gt 0 ]]; then
  for line in "${lines[@]}"; do
    if [[ -z "$filter" || "$line" == *"$filter"* ]]; then
      target="$line"
      break
    fi
  done
elif [[ -f "$cache_file" ]]; then
  target="$(cat "$cache_file")"
fi

if [[ -z "$target" ]]; then
  echo "No wireless adb connect service found. Check Developer options -> Wireless debugging." >&2
  if [[ ${#lines[@]} -gt 0 ]]; then
    printf 'Discovered:\n%s\n' "${lines[*]}" >&2
  fi
  exit 1
fi

adb connect "$target" >/dev/null
printf '%s\n' "$target" > "$cache_file"
echo "$target"
adb devices -l
