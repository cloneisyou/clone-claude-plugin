import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const endpoint = 'https://clone--clone.run.tools'

async function rpc(method, params = {}) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      cloneApiKey: process.env.CLONE_API_TOKEN ?? '',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    }),
  })

  const text = await res.text()
  return { status: res.status, text }
}

describe('Smithery Clone MCP connection', () => {
  it('reaches the published Smithery endpoint', async () => {
    const res = await fetch(endpoint, { method: 'HEAD' })
    assert.notEqual(res.status, 404)
  })

  it(
    'can call predict_next_prompt when CLONE_API_TOKEN is a valid Clone API key',
    { skip: !process.env.CLONE_API_TOKEN },
    async () => {
      const init = await rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'clone-plugin-test', version: '0.0.0' },
      })
      assert.ok(init.status < 500, init.text)

      const tools = await rpc('tools/list')
      assert.equal(tools.status, 200, tools.text)
      assert.match(tools.text, /predict_next_prompt/)

      const prediction = await rpc('tools/call', {
        name: 'predict_next_prompt',
        arguments: {
          agent: 'Claude Code Clone Loop',
          agent_input: 'We are testing the Clone Claude plugin MCP path.',
          k: 1,
          threshold: 0.8,
        },
      })
      assert.equal(prediction.status, 200, prediction.text)
      assert.match(prediction.text, /predicted_response|confidence|error/)
    },
  )
})
