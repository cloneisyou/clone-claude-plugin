import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const root = new URL('../', import.meta.url)

function read(path) {
  return readFileSync(new URL(path, root), 'utf8')
}

describe('Clone Claude plugin contract', () => {
  it('publishes the plugin under the clone slug', () => {
    const manifest = JSON.parse(read('.claude-plugin/plugin.json'))

    assert.equal(manifest.name, 'clone')
    assert.match(manifest.description, /Clone/i)
    assert.match(manifest.description, /Ralph/i)
  })

  it('includes every upstream Ralph Loop plugin file plus Clone command aliases', () => {
    const upstreamFiles = [
      '.claude-plugin/plugin.json',
      'commands/cancel-ralph.md',
      'commands/help.md',
      'commands/ralph-loop.md',
      'hooks/hooks.json',
      'hooks/stop-hook.sh',
      'LICENSE',
      'README.md',
      'scripts/setup-ralph-loop.sh',
    ]

    for (const file of upstreamFiles) {
      assert.equal(existsSync(new URL(file, root)), true, `${file} exists`)
    }
    assert.equal(existsSync(new URL('commands/loop.md', root)), true)
    assert.equal(existsSync(new URL('commands/cancel-loop.md', root)), true)
  })

  it('registers the remote Clone MCP server for Claude Code', () => {
    const mcp = JSON.parse(read('.mcp.json'))

    assert.equal(mcp.mcpServers.clone.url, 'https://api.clone.is/mcp')
    assert.equal(
      mcp.mcpServers.clone.headers['X-Clone-API-Key'],
      '${CLONE_API_TOKEN}',
    )
  })

  it('documents /clone:loop as the primary command', () => {
    const readme = read('README.md')
    const loopCommand = read('commands/loop.md')

    assert.match(readme, /\/clone:loop/)
    assert.match(loopCommand, /# Clone Loop Command/)
  })

  it('persists Clone prediction settings when starting a Ralph loop', () => {
    const setup = read('scripts/setup-ralph-loop.sh')

    assert.match(setup, /CLONE_THRESHOLD="0\.8"/)
    assert.match(setup, /CLONE_K="1"/)
    assert.match(setup, /CLONE_AGENT="Claude Code Clone Loop"/)
    assert.match(setup, /--clone-threshold/)
    assert.match(setup, /clone_threshold: \$CLONE_THRESHOLD/)
    assert.match(setup, /clone_k: \$CLONE_K/)
    assert.match(setup, /clone_agent: "\$CLONE_AGENT"/)
  })

  it('asks Claude to call Clone MCP and use confident predictions as the next prompt', () => {
    const hook = read('hooks/stop-hook.sh')

    assert.match(hook, /mcp__clone__predict_next_prompt/)
    assert.match(hook, /last_assistant_message/)
    assert.match(hook, /predicted_response/)
    assert.match(hook, /confidence/)
    assert.match(hook, /clone_threshold/)
    assert.match(hook, /human escalation/)
    assert.doesNotMatch(hook, /mcp__clone__submit_feedback/)
  })
})
