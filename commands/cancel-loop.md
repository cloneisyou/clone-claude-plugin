---
description: "Cancel active Clone Loop"
argument-hint: ""
allowed-tools: Bash(node *cancel-clone-loop.mjs*)
hide-from-slash-command-tool: "true"
---

# Cancel Clone Loop

Use the Bash tool to execute the Node cancel script:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cancel-clone-loop.mjs"
```

The script removes `.claude/clone-loop.local.md`, calls Clone MCP `stop_session`
when a Clone session id is present in the state file, and reports the cancelled
iteration. If no loop is active it prints "No active Clone Loop found." and
exits successfully.
