import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const scriptPath = join(pluginRoot, 'scripts', 'cancel-clone-loop.mjs')

function runCancel(workdir, env = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: workdir,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (status) => resolveRun({ status, stdout, stderr }))
  })
}

describe('Clone Loop cancel script', () => {
  let workdir
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'clone-loop-cancel-'))
  })
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  it('reports no active loop when state file is missing', async () => {
    const result = await runCancel(workdir)
    assert.equal(result.status, 0)
    assert.match(result.stdout, /No active Clone Loop found/)
  })

  it('removes state file and reports iteration when no clone_session_id is set', async () => {
    mkdirSync(join(workdir, '.claude'), { recursive: true })
    writeFileSync(
      join(workdir, '.claude', 'clone-loop.local.md'),
      `---\niteration: 4\nmax_iterations: 10\nsession_id: s-1\n---\nDo work.\n`,
    )

    const result = await runCancel(workdir)
    assert.equal(result.status, 0, JSON.stringify(result))
    assert.match(result.stdout, /iteration 4/)
    assert.throws(() => readFileSync(join(workdir, '.claude', 'clone-loop.local.md')))
  })

  it('calls Clone MCP stop_session when clone_session_id is present', async () => {
    mkdirSync(join(workdir, '.claude'), { recursive: true })
    writeFileSync(
      join(workdir, '.claude', 'clone-loop.local.md'),
      `---\niteration: 2\nmax_iterations: 10\nsession_id: s-1\nclone_session_id: "clone-sess-cancel"\nmcp_session_id: "mcp-sess-cancel"\n---\nDo work.\n`,
    )

    const calls = []
    const server = createServer(async (req, res) => {
      let body = ''
      req.setEncoding('utf8')
      for await (const chunk of req) body += chunk
      const payload = JSON.parse(body)
      calls.push({ method: payload.method, params: payload.params })
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/event-stream')
      if (payload.method === 'initialize') {
        res.setHeader('mcp-session-id', 'mcp-sess-cancel')
        res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { capabilities: {} } })}\n\n`)
        return
      }
      res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { content: [{ type: 'text', text: '{"ok":true}' }] } })}\n\n`)
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const { port } = server.address()
    try {
      const result = await runCancel(workdir, { CLONE_MCP_URL: `http://127.0.0.1:${port}/mcp`, CLONE_API_TOKEN: 'test-token' })
      assert.equal(result.status, 0, JSON.stringify(result))
      const toolCalls = calls.filter((c) => c.method === 'tools/call')
      const names = toolCalls.map((c) => c.params.name)
      assert.ok(names.includes('stop_session'), `stop_session should be called: ${names.join(', ')}`)
      const stopCall = toolCalls.find((c) => c.params.name === 'stop_session')
      assert.equal(stopCall.params.arguments.session_id, 'clone-sess-cancel')
    } finally {
      await new Promise((r) => server.close(r))
    }
  })
})
