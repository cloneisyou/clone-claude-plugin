// Manual e2e: build agent_input via the real conversation-context helpers
// and call live Clone MCP predict_next_prompt. Prints the request payload and
// the response. Not part of automated tests.

import { resolveCloneToken } from './clone-auth.mjs'
import {
  HISTORY_WINDOW_TURNS,
  formatConversationHistory,
} from './conversation-context.mjs'

const endpoint = process.env.CLONE_MCP_URL || 'https://api.clone.is/mcp'

function parseSse(text) {
  const frames = text
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .join('\n')
        .trim(),
    )
    .filter(Boolean)
  for (const frame of frames) {
    try { return JSON.parse(frame) } catch {}
  }
  return text ? JSON.parse(text) : null
}

async function rpc(token, method, params, sessionId) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'X-Clone-API-Key': token,
  }
  if (sessionId) headers['mcp-session-id'] = sessionId
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`)
  return { sessionId: res.headers.get('mcp-session-id') || sessionId, payload: text ? parseSse(text) : null }
}

const promptText = 'Build a small REST API for todos with CRUD endpoints, validation, and tests.'
const injectedUserTurns = [
  { ts: '2026-05-12T10:00:00Z', source: 'clone-prediction', text: 'Add input validation for the POST /todos endpoint.', iteration: 2 },
  { ts: '2026-05-12T10:05:00Z', source: 'auto-answer', text: 'Q: Should we use Zod or Joi for validation?\nA: Zod' },
  { ts: '2026-05-12T10:10:00Z', source: 'clone-prediction', text: 'Now write integration tests for the validation errors.', iteration: 3 },
]
// Simulated current-iteration transcript with text + tool_use + tool_result
// so this script exercises the rich agent_input builder end-to-end.
const iterationBlocks = [
  { kind: 'text', text: 'I will start by reading the current routes file to see what is already wired up.' },
  { kind: 'tool_use', name: 'Read', input: { file_path: 'src/routes/todos.ts' } },
  { kind: 'tool_result', name: 'Read', text: '1\timport { Router } from \'express\'\n2\timport { db } from \'../db\'\n3\t\n4\tconst router = Router()\n5\trouter.post(\'/\', async (req, res) => {\n6\t  const todo = await db.todo.create({ data: req.body })\n7\t  res.json(todo)\n8\t})\n9\trouter.patch(\'/:id\', async (req, res) => {\n10\t  const todo = await db.todo.update({ where: { id: req.params.id }, data: req.body })\n11\t  res.json(todo)\n12\t})\n... [40 more Read output lines] ...\n51\texport default router' },
  { kind: 'tool_use', name: 'Edit', input: { file_path: 'src/routes/todos.ts', old_string: 'router.post(...)', new_string: 'router.post(..., validate(TodoCreateSchema))' } },
  { kind: 'tool_result', name: 'Edit', text: 'The file src/routes/todos.ts has been updated successfully.' },
  { kind: 'text', text: 'Now I will add Zod schemas and apply them to POST /todos and PATCH /todos/:id. The handlers will reject malformed bodies with HTTP 400 and a structured error envelope.' },
  { kind: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } },
  { kind: 'tool_result', name: 'Bash', text: '> clone-claude-plugin-tests@ test\n> node --test tests/...\n  ✔ validates required fields\n  ✔ rejects unknown keys\n  ✔ returns 400 on malformed body\n... [12 more Bash lines] ...\nℹ tests 23\nℹ pass 23\nℹ fail 0' },
  { kind: 'text', text: 'Schemas applied and the unit test suite is green. Next I would write integration tests that hit the express app via supertest.' },
]

const agentInput = formatConversationHistory({
  promptText,
  iteration: 4,
  threshold: '0.6',
  injectedUserTurns,
  iterationBlocks,
  windowTurns: HISTORY_WINDOW_TURNS,
})

const { token, source, masked } = resolveCloneToken()
console.error(`[manual-e2e] token source=${source} (${masked})`)
console.error(`[manual-e2e] endpoint=${endpoint}`)
console.error('[manual-e2e] === agent_input ===')
console.error(agentInput)
console.error('[manual-e2e] === end agent_input ===')

const init = await rpc(token, 'initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'clone-plugin-manual-e2e', version: '0.0.0' },
})
console.error(`[manual-e2e] initialize ok, mcp-session=${init.sessionId}`)

const call = await rpc(token, 'tools/call', {
  name: 'predict_next_prompt',
  arguments: {
    agent: 'Claude Code Clone Loop',
    agent_input: agentInput,
    k: 1,
    threshold: 0.6,
  },
}, init.sessionId)

const content = call.payload?.result?.content?.[0]
if (!content || content.type !== 'text') {
  console.error('[manual-e2e] no text content in response')
  console.error(JSON.stringify(call.payload, null, 2))
  process.exit(1)
}

const prediction = JSON.parse(content.text)
console.log(JSON.stringify(prediction, null, 2))
