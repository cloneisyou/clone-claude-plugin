#!/bin/bash

# Clone Loop Stop Hook.
# Based on Anthropic's Ralph Loop plugin stop hook.
# Blocks session exit while a Clone Loop is active and asks Claude to call
# Clone MCP for the predicted next user prompt.

set -euo pipefail

HOOK_INPUT=$(cat)
LOOP_STATE_FILE=".claude/clone-loop.local.md"

if [[ ! -f "$LOOP_STATE_FILE" ]]; then
  exit 0
fi

FRONTMATTER=$(sed -n '/^---$/,/^---$/{ /^---$/d; p; }' "$LOOP_STATE_FILE")
ITERATION=$(echo "$FRONTMATTER" | grep '^iteration:' | sed 's/iteration: *//')
MAX_ITERATIONS=$(echo "$FRONTMATTER" | grep '^max_iterations:' | sed 's/max_iterations: *//')
COMPLETION_PROMISE=$(echo "$FRONTMATTER" | grep '^completion_promise:' | sed 's/completion_promise: *//' | sed 's/^"\(.*\)"$/\1/')
CLONE_THRESHOLD=$(echo "$FRONTMATTER" | grep '^clone_threshold:' | sed 's/clone_threshold: *//' || true)
CLONE_K=$(echo "$FRONTMATTER" | grep '^clone_k:' | sed 's/clone_k: *//' || true)
CLONE_AGENT=$(echo "$FRONTMATTER" | grep '^clone_agent:' | sed 's/clone_agent: *//' | sed 's/^"\(.*\)"$/\1/' || true)

CLONE_THRESHOLD="${CLONE_THRESHOLD:-0.8}"
CLONE_K="${CLONE_K:-1}"
CLONE_AGENT="${CLONE_AGENT:-Claude Code Clone Loop}"

STATE_SESSION=$(echo "$FRONTMATTER" | grep '^session_id:' | sed 's/session_id: *//' || true)
HOOK_SESSION=$(echo "$HOOK_INPUT" | jq -r '.session_id // ""')
if [[ -n "$STATE_SESSION" ]] && [[ "$STATE_SESSION" != "$HOOK_SESSION" ]]; then
  exit 0
fi

if [[ ! "$ITERATION" =~ ^[0-9]+$ ]]; then
  echo "Clone Loop: state file corrupted; iteration is not numeric." >&2
  rm "$LOOP_STATE_FILE"
  exit 0
fi

if [[ ! "$MAX_ITERATIONS" =~ ^[0-9]+$ ]]; then
  echo "Clone Loop: state file corrupted; max_iterations is not numeric." >&2
  rm "$LOOP_STATE_FILE"
  exit 0
fi

if [[ ! "$CLONE_K" =~ ^[0-9]+$ ]] || [[ "$CLONE_K" -lt 1 ]] || [[ "$CLONE_K" -gt 10 ]]; then
  echo "Clone Loop: state file corrupted; clone_k must be 1-10." >&2
  rm "$LOOP_STATE_FILE"
  exit 0
fi

if [[ $MAX_ITERATIONS -gt 0 ]] && [[ $ITERATION -ge $MAX_ITERATIONS ]]; then
  echo "Clone Loop: Max iterations ($MAX_ITERATIONS) reached."
  rm "$LOOP_STATE_FILE"
  exit 0
fi

HOOK_LAST_MESSAGE=$(echo "$HOOK_INPUT" | jq -r '.last_assistant_message // ""')
LAST_OUTPUT="$HOOK_LAST_MESSAGE"

if [[ -z "$LAST_OUTPUT" ]]; then
  TRANSCRIPT_PATH=$(echo "$HOOK_INPUT" | jq -r '.transcript_path')
  if [[ ! -f "$TRANSCRIPT_PATH" ]]; then
    echo "Clone Loop: Transcript file not found; stopping." >&2
    rm "$LOOP_STATE_FILE"
    exit 0
  fi

  if ! grep -q '"role":"assistant"' "$TRANSCRIPT_PATH"; then
    echo "Clone Loop: No assistant messages found; stopping." >&2
    rm "$LOOP_STATE_FILE"
    exit 0
  fi

  LAST_LINES=$(grep '"role":"assistant"' "$TRANSCRIPT_PATH" | tail -n 100)
  if [[ -z "$LAST_LINES" ]]; then
    echo "Clone Loop: Failed to extract assistant messages; stopping." >&2
    rm "$LOOP_STATE_FILE"
    exit 0
  fi

  set +e
  LAST_OUTPUT=$(echo "$LAST_LINES" | jq -rs '
    map(.message.content[]? | select(.type == "text") | .text) | last // ""
  ' 2>&1)
  JQ_EXIT=$?
  set -e

  if [[ $JQ_EXIT -ne 0 ]]; then
    echo "Clone Loop: Failed to parse assistant message JSON." >&2
    echo "Error: $LAST_OUTPUT" >&2
    rm "$LOOP_STATE_FILE"
    exit 0
  fi
fi

if [[ "$COMPLETION_PROMISE" != "null" ]] && [[ -n "$COMPLETION_PROMISE" ]]; then
  PROMISE_TEXT=$(echo "$LAST_OUTPUT" | perl -0777 -pe 's/.*?<promise>(.*?)<\/promise>.*/$1/s; s/^\s+|\s+$//g; s/\s+/ /g' 2>/dev/null || echo "")
  if [[ -n "$PROMISE_TEXT" ]] && [[ "$PROMISE_TEXT" = "$COMPLETION_PROMISE" ]]; then
    echo "Clone Loop: Detected <promise>$COMPLETION_PROMISE</promise>"
    rm "$LOOP_STATE_FILE"
    exit 0
  fi
fi

NEXT_ITERATION=$((ITERATION + 1))

PROMPT_TEXT=$(awk '/^---$/{i++; next} i>=2' "$LOOP_STATE_FILE")
if [[ -z "$PROMPT_TEXT" ]]; then
  echo "Clone Loop: State file has no prompt text; stopping." >&2
  rm "$LOOP_STATE_FILE"
  exit 0
fi

TEMP_FILE="${LOOP_STATE_FILE}.tmp.$$"
sed "s/^iteration: .*/iteration: $NEXT_ITERATION/" "$LOOP_STATE_FILE" > "$TEMP_FILE"
mv "$TEMP_FILE" "$LOOP_STATE_FILE"

if [[ "$COMPLETION_PROMISE" != "null" ]] && [[ -n "$COMPLETION_PROMISE" ]]; then
  SYSTEM_MSG="Clone Loop iteration $NEXT_ITERATION | To stop: output <promise>$COMPLETION_PROMISE</promise> only when true."
else
  SYSTEM_MSG="Clone Loop iteration $NEXT_ITERATION | No completion promise set."
fi

AGENT_INPUT=$(cat <<EOF
Original Clone Loop prompt:
$PROMPT_TEXT

Clone Loop iteration: $NEXT_ITERATION
Clone threshold: $CLONE_THRESHOLD

Claude last_assistant_message:
$LAST_OUTPUT
EOF
)

CONTINUATION_PROMPT=$(cat <<EOF
You are continuing a Clone Loop.

Before doing any more work, call the Clone MCP tool mcp__clone__predict_next_prompt with:
- agent: $CLONE_AGENT
- agent_input: the block below
- k: $CLONE_K
- threshold: $CLONE_THRESHOLD
- session_id: $HOOK_SESSION

agent_input:
$AGENT_INPUT

After the MCP result:
1. If status is "auto" OR confidence is greater than or equal to clone_threshold ($CLONE_THRESHOLD), treat predicted_response as the next user prompt for this Clone Loop iteration and act on it.
2. If status is "escalated", confidence is below clone_threshold, or the MCP call fails, this requires human escalation. Remove .claude/clone-loop.local.md, tell the user Clone was not confident enough, and stop.
3. Keep the original Ralph completion promise rule: only output <promise>$COMPLETION_PROMISE</promise> when it is genuinely true.
EOF
)

jq -n \
  --arg prompt "$CONTINUATION_PROMPT" \
  --arg msg "$SYSTEM_MSG" \
  '{
    "decision": "block",
    "reason": $prompt,
    "systemMessage": $msg
  }'

exit 0
