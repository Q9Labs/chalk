#!/bin/bash
# Claude Code Statusline - Minimal & Clean v2.2.0
# Shows: directory, git, model, context, weekly %, reset timer
STATUSLINE_VERSION="2.2.0"

# ============ CONFIGURATION ============
# Set your weekly spending limit (in USD) based on your plan
# Pro: ~$100/week, Team: varies. Adjust as needed.
WEEKLY_LIMIT=100
# =======================================

# ---- Path Setup ----
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.npm-global/bin:$HOME/.nvm/current/bin"

# Read input
input=$(cat)

# ---- Tools Check ----
HAS_JQ=0; command -v jq >/dev/null 2>&1 && HAS_JQ=1
HAS_CC=0; command -v ccusage >/dev/null 2>&1 && HAS_CC=1

# ---- Theme ----
if [ -n "$NO_COLOR" ]; then
  R="" D="" A="" B="" G="" M="" W="" S="" X="" T=""
else
  R="\033[0m"           # Reset
  D="\033[38;5;238m"    # Dim (separators)
  A="\033[38;5;75m"     # Accent (directory)
  B="\033[38;5;249m"    # Base text
  G="\033[38;5;114m"    # Git branch
  M="\033[38;5;183m"    # Model
  W="\033[38;5;209m"    # Warning (high usage)
  S="\033[38;5;114m"    # Success (low usage)
  X="\033[38;5;245m"    # Muted labels
  T="\033[38;5;180m"    # Timer/reset
fi

# ---- Helpers ----
to_epoch() {
  local ts="$1"
  if command -v gdate >/dev/null 2>&1; then gdate -d "$ts" +%s 2>/dev/null && return; fi
  date -u -j -f "%Y-%m-%dT%H:%M:%S%z" "${ts/Z/+0000}" +%s 2>/dev/null && return
  python3 - "$ts" <<'PY' 2>/dev/null
import sys, datetime
s=sys.argv[1].replace('Z','+00:00')
print(int(datetime.datetime.fromisoformat(s).timestamp()))
PY
}

fmt_duration() {
  local sec=$1
  if [ "$sec" -le 0 ]; then echo "now"; return; fi
  if [ "$sec" -ge 3600 ]; then
    printf "%dh%dm" $((sec/3600)) $(((sec%3600)/60))
  else
    printf "%dm" $((sec/60))
  fi
}

# ---- Extract Info ----
if [ "$HAS_JQ" -eq 1 ]; then
  dir=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // "~"' 2>/dev/null | sed "s|^$HOME|~|")
  model=$(echo "$input" | jq -r '.model.display_name // "Claude"' 2>/dev/null)
  sess_id=$(echo "$input" | jq -r '.session_id // ""' 2>/dev/null)
else
  dir="~"; model="Claude"; sess_id=""
fi

# Shorten directory
short_dir=$(echo "$dir" | awk -F/ '{
  if (NF <= 3) print $0
  else print $(NF-1)"/"$NF
}')

# ---- Git Branch ----
git_branch=""
if git rev-parse --git-dir >/dev/null 2>&1; then
  git_branch=$(git branch --show-current 2>/dev/null || git rev-parse --short HEAD 2>/dev/null)
fi

# ---- Context Usage ----
ctx_used="" ctx_color="$S"
if [ -n "$sess_id" ] && [ "$HAS_JQ" -eq 1 ]; then
  max_ctx=200000  # All Claude 4.5 models have 200k context

  # Find session file by ID (more reliable than constructing path)
  sess_file=$(find "$HOME/.claude/projects" -name "${sess_id}.jsonl" -type f 2>/dev/null | head -1)

  if [ -n "$sess_file" ] && [ -f "$sess_file" ]; then
    # Get the most recent usage entry (input + cache + output tokens)
    toks=$(tail -50 "$sess_file" | jq -r 'select(.message.usage) | .message.usage | ((.input_tokens // 0) + (.cache_read_input_tokens // 0) + (.output_tokens // 0))' 2>/dev/null | tail -1)
    if [ -n "$toks" ] && [ "$toks" -gt 0 ]; then
      pct=$(( toks * 100 / max_ctx ))
      ctx_used="${pct}%%"
      if [ "$pct" -ge 80 ]; then
        ctx_color="$W"
      elif [ "$pct" -ge 50 ]; then
        ctx_color="$B"
      fi
    fi
  fi
fi

# ---- Weekly Usage & Block Reset (via ccusage) ----
weekly_pct="" weekly_color="$S"
reset_time=""

if [ "$HAS_CC" -eq 1 ] && [ "$HAS_JQ" -eq 1 ]; then
  # Weekly usage percentage
  wk_json=$(ccusage weekly --json 2>/dev/null)
  if [ -n "$wk_json" ]; then
    wk_cost=$(echo "$wk_json" | jq -r '.weekly[0].totalCost // 0' 2>/dev/null)
    if [ -n "$wk_cost" ] && [ "$WEEKLY_LIMIT" -gt 0 ]; then
      # Calculate percentage (using bc for float math)
      wk_pct=$(echo "scale=0; $wk_cost * 100 / $WEEKLY_LIMIT" | bc 2>/dev/null)
      if [ -n "$wk_pct" ]; then
        weekly_pct="${wk_pct}%%"
        if [ "$wk_pct" -ge 80 ]; then
          weekly_color="$W"
        elif [ "$wk_pct" -ge 50 ]; then
          weekly_color="$B"
        fi
      fi
    fi
  fi

  # Block reset time
  blk_json=$(ccusage blocks --json 2>/dev/null)
  if [ -n "$blk_json" ]; then
    active=$(echo "$blk_json" | jq -c '.blocks[] | select(.isActive == true)' 2>/dev/null | head -n1)
    if [ -n "$active" ]; then
      reset_iso=$(echo "$active" | jq -r '.usageLimitResetTime // .endTime // empty' 2>/dev/null)
      if [ -n "$reset_iso" ]; then
        now=$(date +%s)
        target=$(to_epoch "$reset_iso")
        diff=$(( target - now ))
        reset_time=$(fmt_duration "$diff")
      fi
    fi
  fi
fi

# ---- Render Statusline ----
printf "${A}${short_dir}${R}"

if [ -n "$git_branch" ]; then
  printf " ${D}│${R} ${G}${git_branch}${R}"
fi

printf " ${D}│${R} ${M}${model}${R}"

# Context
if [ -n "$ctx_used" ]; then
  printf " ${D}│${R} ${X}ctx${R} ${ctx_color}${ctx_used}${R}"
else
  printf " ${D}│${R} ${X}ctx${R} ${B}--${R}"
fi

# Weekly usage display removed per user request

# Reset timer
if [ -n "$reset_time" ]; then
  printf " ${D}│${R} ${X}reset${R} ${T}${reset_time}${R}"
fi

printf "\n"
