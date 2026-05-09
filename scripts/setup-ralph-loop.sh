#!/bin/bash

# Clone Loop Setup Script.
# Based on Anthropic's Ralph Loop plugin setup script.
# Creates state for an in-session Clone Loop, plus Clone MCP prediction settings.

set -euo pipefail

PROMPT_PARTS=()
MAX_ITERATIONS=0
COMPLETION_PROMISE="null"
CLONE_THRESHOLD="0.8"
CLONE_K="1"
CLONE_AGENT="Claude Code Clone Loop"

is_threshold() {
  [[ "$1" =~ ^(0(\.[0-9]+)?|1(\.0+)?)$ ]]
}

usage() {
  cat <<'HELP_EOF'
Clone Loop - iterative development loop with Clone-predicted next prompts

USAGE:
  /clone:loop [PROMPT...] [OPTIONS]

ARGUMENTS:
  PROMPT...    Initial Ralph task prompt.

OPTIONS:
  --max-iterations <n>           Maximum iterations before auto-stop (default: unlimited)
  --completion-promise '<text>'  Promise phrase that signals genuine completion
  --clone-threshold <n>          Clone auto/escalation threshold in [0, 1] (default: 0.8)
  --clone-k <n>                  Number of Clone candidate prompts to request, 1-10 (default: 1)
  --clone-agent '<text>'         Agent label sent to Clone (default: Claude Code Clone Loop)
  -h, --help                     Show this help message

DESCRIPTION:
  Starts a Clone Loop in your current session. The stop hook prevents exit,
  asks Clone MCP to predict the next user prompt, and continues only when
  Clone is confident enough.

  To signal completion, output: <promise>YOUR_PHRASE</promise>

EXAMPLES:
  /clone:loop Build a todo API --completion-promise DONE --max-iterations 20
  /clone:loop Fix the auth bug --max-iterations 10 --clone-threshold 0.75
  /clone:loop Refactor cache layer --clone-k 3
HELP_EOF
}

while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help)
      usage
      exit 0
      ;;
    --max-iterations)
      if [[ -z "${2:-}" ]] || ! [[ "$2" =~ ^[0-9]+$ ]]; then
        echo "Error: --max-iterations requires a positive integer or 0." >&2
        exit 1
      fi
      MAX_ITERATIONS="$2"
      shift 2
      ;;
    --completion-promise)
      if [[ -z "${2:-}" ]]; then
        echo "Error: --completion-promise requires text." >&2
        exit 1
      fi
      COMPLETION_PROMISE="$2"
      shift 2
      ;;
    --clone-threshold)
      if [[ -z "${2:-}" ]] || ! is_threshold "$2"; then
        echo "Error: --clone-threshold must be a number in [0, 1]." >&2
        exit 1
      fi
      CLONE_THRESHOLD="$2"
      shift 2
      ;;
    --clone-k)
      if [[ -z "${2:-}" ]] || ! [[ "$2" =~ ^[0-9]+$ ]] || [[ "$2" -lt 1 ]] || [[ "$2" -gt 10 ]]; then
        echo "Error: --clone-k must be an integer from 1 to 10." >&2
        exit 1
      fi
      CLONE_K="$2"
      shift 2
      ;;
    --clone-agent)
      if [[ -z "${2:-}" ]]; then
        echo "Error: --clone-agent requires text." >&2
        exit 1
      fi
      CLONE_AGENT="$2"
      shift 2
      ;;
    *)
      PROMPT_PARTS+=("$1")
      shift
      ;;
  esac
done

PROMPT="${PROMPT_PARTS[*]:-}"

if [[ -z "$PROMPT" ]]; then
  echo "Error: No prompt provided." >&2
  echo "Example: /clone:loop Build a REST API for todos --max-iterations 20" >&2
  exit 1
fi

mkdir -p .claude

if [[ -n "$COMPLETION_PROMISE" ]] && [[ "$COMPLETION_PROMISE" != "null" ]]; then
  COMPLETION_PROMISE_YAML="\"${COMPLETION_PROMISE//\"/\\\"}\""
else
  COMPLETION_PROMISE_YAML="null"
fi

cat > .claude/clone-loop.local.md <<EOF
---
active: true
iteration: 1
session_id: ${CLAUDE_CODE_SESSION_ID:-}
max_iterations: $MAX_ITERATIONS
completion_promise: $COMPLETION_PROMISE_YAML
clone_threshold: $CLONE_THRESHOLD
clone_k: $CLONE_K
clone_agent: "$CLONE_AGENT"
started_at: "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
---

$PROMPT
EOF

cat <<EOF
Clone Loop activated.

Iteration: 1
Max iterations: $(if [[ $MAX_ITERATIONS -gt 0 ]]; then echo "$MAX_ITERATIONS"; else echo "unlimited"; fi)
Completion promise: $(if [[ "$COMPLETION_PROMISE" != "null" ]]; then echo "$COMPLETION_PROMISE"; else echo "none"; fi)
Clone threshold: $CLONE_THRESHOLD
Clone k: $CLONE_K
Clone agent: $CLONE_AGENT

The stop hook is active. On each stop, Claude will ask Clone MCP to predict
the next user prompt and continue only when confidence clears the threshold.

To monitor: head -10 .claude/clone-loop.local.md
EOF

if [[ -n "$PROMPT" ]]; then
  echo ""
  echo "$PROMPT"
fi

if [[ "$COMPLETION_PROMISE" != "null" ]]; then
  cat <<EOF

CRITICAL - Clone Loop Completion Promise

To complete this loop, output this EXACT text:
  <promise>$COMPLETION_PROMISE</promise>

Only output it when the statement is completely and unequivocally true.
Do not output a false promise to escape the loop.
EOF
fi
