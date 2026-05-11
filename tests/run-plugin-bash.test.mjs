import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runnerPath = join(pluginRoot, 'scripts', 'run-plugin-bash.mjs')

describe('plugin bash launcher', () => {
  it('runs setup scripts from Windows-safe plugin paths', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'clone-loop-launcher-'))

    try {
      const result = spawnSync(
        process.execPath,
        [
          runnerPath,
          'scripts/setup-clone-loop.sh',
          'launcher smoke test',
          '--max-iterations',
          '1',
        ],
        {
          cwd: workdir,
          env: {
            ...process.env,
            CLAUDE_PLUGIN_ROOT: pluginRoot,
          },
          encoding: 'utf8',
        },
      )

      assert.equal(
        result.status,
        0,
        JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2),
      )
      assert.match(result.stdout, /Clone Loop activated/)

      const state = readFileSync(join(workdir, '.claude', 'clone-loop.local.md'), 'utf8')
      assert.match(state, /launcher smoke test/)
      assert.match(state, /max_iterations: 1/)
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })
})
