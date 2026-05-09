# Clone

Clone is a Claude Code plugin that runs Clone Loop.

It vendors Anthropic's official `ralph-loop` plugin and keeps the same core
mechanism: a slash command writes loop state, a Stop hook blocks Claude's
attempt to finish, and the current Claude Code session continues without losing
file changes or git history.

Clone changes the continuation step. Upstream Ralph Loop feeds the same prompt
back to Claude every time. Clone Loop asks Clone MCP to predict what the user
would say next, then continues with that predicted prompt only when confidence
clears the configured threshold.

Based on Anthropic Ralph Loop, modified by Clone. The vendored upstream plugin
is licensed under Apache-2.0; see `LICENSE`.

## Why Clone Loop

Ralph Loop proves the basic loop: keep Claude Code working until the task is
actually finished. Clone Loop keeps that proven control structure, then replaces
the static retry prompt with a personalized next-prompt prediction from Clone.

| Capability | Upstream Ralph Loop | Clone Loop |
| --- | --- | --- |
| Loop trigger | Claude Code Stop hook | Claude Code Stop hook |
| State file | Stores the original prompt and iteration count | Stores the original prompt, iteration count, and Clone prediction settings |
| Next instruction | Replays the same original prompt | Predicts the user's likely next prompt with Clone MCP |
| Personalization | None | Uses the user's Clone memory through `predict_next_prompt` |
| Continuation rule | Continue until max iterations or completion promise | Continue only when Clone returns `auto` or confidence clears the threshold |
| Failure mode | Stop on max iterations, completion, or invalid state | Stop on those conditions plus low confidence, escalation, or MCP failure |

```text
Upstream Ralph Loop
Claude tries to stop -> Stop hook blocks -> same prompt is replayed

Clone Loop
Claude tries to stop -> Stop hook blocks -> Clone predicts next prompt
                    -> confident prediction continues the loop
                    -> low confidence escalates to the human
```

## Upstream Ralph Loop Structure

The official Ralph Loop plugin is intentionally small:

```text
.claude-plugin/plugin.json     Plugin metadata for Claude Code.
commands/ralph-loop.md         Starts the loop by running the setup script.
commands/cancel-ralph.md       Removes the loop state file.
commands/help.md               Explains Ralph Loop to the user.
hooks/hooks.json               Registers a Stop hook.
hooks/stop-hook.sh             Blocks stop and re-injects the prompt.
scripts/setup-ralph-loop.sh    Parses options and writes loop state.
README.md                      User documentation.
LICENSE                        Upstream Apache-2.0 license.
```

The upstream runtime has three moving parts:

1. `/ralph-loop` runs `scripts/setup-ralph-loop.sh`.
2. The setup script writes `.claude/ralph-loop.local.md` with YAML frontmatter
   plus the original prompt.
3. `hooks/stop-hook.sh` runs whenever Claude tries to stop. If the loop is
   still active, it updates the iteration count and returns a Stop hook response
   with `"decision": "block"` and the same original prompt as the next input.

The "self-reference" comes from Claude seeing the files and git history it
already changed. The prompt itself does not change in upstream Ralph Loop.

## What Clone Adds

Clone Loop keeps the upstream file layout and Stop hook lifecycle, then replaces
the continuation prompt source:

- Primary command: `/clone:loop`.
- Legacy aliases: `/clone:ralph-loop` and `/clone:cancel-ralph` remain for
  Ralph-compatible command coverage.
- State file: `.claude/clone-loop.local.md`.
- MCP server: `clone`, connected through Clone's remote MCP endpoint
  `https://api.clone.is/mcp`.
- Prediction tool: `mcp__clone__predict_next_prompt`.
- Continuation rule: use `predicted_response` only when Clone returns `auto` or
  confidence is greater than or equal to `--clone-threshold`.
- Escalation rule: if Clone is not confident enough, if it escalates, or if the
  MCP call fails, remove the state file and ask the human to continue.

This makes Clone Loop different from a normal retry loop. Each iteration is not
"try the same thing again"; it is "ask the user's Clone what they would probably
say next, then proceed as if the user had typed that prompt."

## Requirements

- Claude Code with plugin support.
- Clone API key exported as `CLONE_API_TOKEN`. The plugin sends it to the
  Clone remote MCP endpoint as the `X-Clone-API-Key` header.
- Permission for the Clone MCP tools used by the loop:
  - `mcp__clone__predict_next_prompt`

Runtime shell requirements differ by OS:

- macOS / Linux: `bash`, `node`, `perl`, `sed`, and `awk` must be on `PATH`.
- Windows: Git for Windows is required, and `bash` should resolve to
  `C:\Program Files\Git\bin\bash.exe` rather than WSL's
  `C:\Windows\System32\bash.exe`.

Upstream Ralph Loop uses `jq` for JSON parsing. Clone Loop uses Node instead,
so Windows does not need a separate `jq` install when Git Bash is present.

The plugin registers Clone's remote Streamable HTTP MCP endpoint through
`.mcp.json`:

```json
{
  "mcpServers": {
    "clone": {
      "url": "https://api.clone.is/mcp",
      "headers": {
        "X-Clone-API-Key": "${CLONE_API_TOKEN}"
      }
    }
  }
}
```

Smithery can also manage the same server as a hosted connection:

```bash
smithery mcp add clone/clone --headers '{"cloneApiKey":"your-clone-api-key"}'
```

That path requires a Smithery namespace/API key. The plugin uses Clone's direct
remote MCP endpoint so Claude Code can connect with only `CLONE_API_TOKEN`.

## OS Setup

### macOS / Linux

Set the Clone API key in the shell that launches Claude Code:

```bash
export CLONE_API_TOKEN="clone_yc-reviewer-public-demo-2026"
```

Verify the local runtime tools:

```bash
command -v bash node perl sed awk
```

Validate the plugin:

```bash
claude plugin validate apps/claude-plugin
```

### Windows

Use PowerShell for environment variables:

```powershell
$env:CLONE_API_TOKEN = "clone_yc-reviewer-public-demo-2026"
```

Verify the local runtime tools:

```powershell
Get-Command bash
Get-Command node
Get-Command perl
Get-Command sed
Get-Command awk
```

`Get-Command bash` should point to Git Bash:

```text
C:\Program Files\Git\bin\bash.exe
```

If it points to `C:\Windows\System32\bash.exe`, Claude Code may try to use WSL.
Fix `PATH` so Git Bash comes first, or edit the installed plugin cache
`hooks/hooks.json` to use Git Bash explicitly:

```json
"command": "\"C:/Program Files/Git/bin/bash.exe\" \"${CLAUDE_PLUGIN_ROOT}/hooks/stop-hook.sh\""
```

Validate the plugin:

```powershell
claude.exe plugin validate apps\claude-plugin
```

## Usage

Start Clone Loop:

```bash
/clone:loop "Build a REST API for todos. Requirements: CRUD operations, validation, tests. Output <promise>COMPLETE</promise> when done." --completion-promise "COMPLETE" --max-iterations 20
```

Recommended options:

```bash
/clone:loop "Fix the auth bug and run tests" \
  --max-iterations 10 \
  --completion-promise "COMPLETE" \
  --clone-threshold 0.8 \
  --clone-k 1
```

Cancel the loop:

```bash
/clone:cancel-loop
```

## How It Works

1. `/clone:loop` writes `.claude/clone-loop.local.md`.
2. Claude works on the task.
3. When Claude tries to stop, `hooks/stop-hook.sh` runs.
4. The hook preserves the original Ralph safety checks:
   - inactive loop allows stop
   - session mismatch allows stop
   - corrupted state clears the loop
   - max iteration clears the loop
   - completion promise clears the loop
5. If the loop should continue, the hook blocks stop and instructs Claude to:
   - call `mcp__clone__predict_next_prompt`
   - include the original prompt, current iteration, threshold, and
     `last_assistant_message` in `agent_input`
   - continue with `predicted_response` only when confidence clears threshold
   - remove `.claude/clone-loop.local.md` and ask for human input on escalation

## Options

- `--max-iterations <n>`: stop after N iterations. `0` means unlimited.
- `--completion-promise <text>`: phrase that must appear inside
  `<promise>...</promise>` to complete the loop.
- `--clone-threshold <n>`: Clone confidence threshold in `[0, 1]`; default
  `0.8`.
- `--clone-k <n>`: number of Clone candidate prompts to request, `1-10`;
  default `1`.
- `--clone-agent <text>`: agent label sent to Clone; default
  `Claude Code Clone Loop`.

## Prompt Guidance

Good Ralph prompts have explicit success criteria and automated verification:

```markdown
Implement feature X using TDD.

Success criteria:
- Tests cover happy path and failure path
- `npm test` passes
- README documents the new command
- Output <promise>COMPLETE</promise> only when all criteria are true
```

Always set a reasonable `--max-iterations` for new tasks.

## Development

Run the plugin contract tests on macOS / Linux:

```bash
cd apps/claude-plugin
npm test
```

Run the plugin contract tests on Windows PowerShell:

```powershell
Set-Location apps\claude-plugin
npm test
```

Check the live remote Clone MCP endpoint on macOS / Linux:

```bash
cd apps/claude-plugin
npm run test:mcp
```

Check the live remote Clone MCP endpoint on Windows PowerShell:

```powershell
Set-Location apps\claude-plugin
npm run test:mcp
```

`npm run test:mcp` uses the public YC reviewer demo key by default. To test a
different account, set `CLONE_API_TOKEN` first:

```bash
export CLONE_API_TOKEN="clone_xxx"
npm run test:mcp
```

or on Windows:

```powershell
$env:CLONE_API_TOKEN = "clone_xxx"
npm run test:mcp
```

Validate with Claude Code on macOS / Linux:

```bash
claude plugin validate apps/claude-plugin
```

Validate with Claude Code on Windows:

```powershell
claude.exe plugin validate apps\claude-plugin
```
