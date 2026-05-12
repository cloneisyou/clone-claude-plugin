// Side-by-side experiment: current (text-only) builder vs proposed
// "rich" builder that also includes tool_use call lines and short
// tool_result summaries. Calls live Clone MCP once for each variant
// using the same scenario, prints both agent_inputs and both prediction
// responses. Not a regression test — a manual A/B probe.

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

async function callPredict(token, agentInput, label) {
  const init = await rpc(token, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: `clone-plugin-compare-${label}`, version: '0.0.0' },
  })
  const call = await rpc(token, 'tools/call', {
    name: 'predict_next_prompt',
    arguments: {
      agent: 'Claude Code Clone Loop',
      agent_input: agentInput,
      k: 3,
      threshold: 0.8,
    },
  }, init.sessionId)
  const content = call.payload?.result?.content?.[0]
  if (!content || content.type !== 'text') {
    throw new Error(`[${label}] no text content`)
  }
  return JSON.parse(content.text)
}

// ----- Shared scenario -----------------------------------------------------

const promptText =
  'Build a small REST API for todos with CRUD endpoints, validation, and tests.'

const injectedUserTurns = [
  { ts: '2026-05-12T10:00:00Z', source: 'clone-prediction', text: 'Add input validation for the POST /todos endpoint.', iteration: 2 },
  { ts: '2026-05-12T10:05:00Z', source: 'auto-answer', text: 'Q: Should we use Zod or Joi for validation?\nA: Zod' },
  { ts: '2026-05-12T10:10:00Z', source: 'clone-prediction', text: 'Now write integration tests for the validation errors.', iteration: 3 },
]

// Plain text-only assistant blocks (what the current builder uses).
const assistantTexts = [
  'I will start by reading the current routes file to see what is already wired up.',
  'Now I will add Zod schemas and apply them to POST /todos and PATCH /todos/:id. The handlers will reject malformed bodies with HTTP 400 and a structured error envelope.',
  'Schemas applied and the unit test suite is green. Next I would write integration tests that hit the express app via supertest.',
]

// Simulated transcript blocks for the *rich* builder: mix of text, tool_use,
// and tool_result. Order is chronological within the iteration.
const transcriptBlocks = [
  { kind: 'text', text: 'I will start by reading the current routes file to see what is already wired up.' },
  { kind: 'tool_use', name: 'Read', input: { file_path: 'src/routes/todos.ts' } },
  { kind: 'tool_result', name: 'Read', text: '1\timport { Router } from \'express\'\n2\timport { db } from \'../db\'\n3\t\n4\tconst router = Router()\n5\trouter.post(\'/\', async (req, res) => {\n6\t  const todo = await db.todo.create({ data: req.body })\n7\t  res.json(todo)\n8\t})\n... 42 more lines ...\n51\texport default router\n' },
  { kind: 'tool_use', name: 'Edit', input: { file_path: 'src/routes/todos.ts', edits: '+18 / -3' } },
  { kind: 'tool_result', name: 'Edit', text: 'The file src/routes/todos.ts has been updated successfully.' },
  { kind: 'text', text: 'Now I will add Zod schemas and apply them to POST /todos and PATCH /todos/:id. The handlers will reject malformed bodies with HTTP 400 and a structured error envelope.' },
  { kind: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } },
  { kind: 'tool_result', name: 'Bash', text: '> clone-claude-plugin-tests@ test\n> node --test tests/...\n... 14 passing tests ...\nℹ tests 21\nℹ pass 21\nℹ fail 0\n' },
  { kind: 'text', text: 'Schemas applied and the unit test suite is green. Next I would write integration tests that hit the express app via supertest.' },
]

// ----- Rich formatter (proposed) ------------------------------------------

const HEAD = 4
const TAIL = 2

function summarize(text, name) {
  const t = String(text || '').replace(/\r\n/g, '\n')
  const lines = t.split('\n')
  if (lines.length <= HEAD + TAIL + 1) {
    return t.trim()
  }
  const head = lines.slice(0, HEAD).join('\n')
  const tail = lines.slice(-TAIL).join('\n')
  return `${head}\n... [${lines.length - HEAD - TAIL} more ${name} output lines] ...\n${tail}`
}

function formatToolUseLine(block) {
  const inp = block.input || {}
  const args = Object.entries(inp)
    .map(([k, v]) => {
      if (typeof v === 'string' && v.length > 80) return `${k}=${v.slice(0, 77)}...`
      return `${k}=${JSON.stringify(v)}`
    })
    .join(' ')
  return `[tool_use] ${block.name}: ${args}`
}

function formatToolResultBlock(block) {
  return `[tool_result] ${block.name}:\n${summarize(block.text, block.name)}`
}

function formatRichIteration(transcriptBlocks, iteration) {
  const parts = []
  for (const b of transcriptBlocks) {
    if (b.kind === 'text') parts.push(b.text)
    else if (b.kind === 'tool_use') parts.push(formatToolUseLine(b))
    else if (b.kind === 'tool_result') parts.push(formatToolResultBlock(b))
  }
  return `### assistant (current iter ${iteration}, rich):\n${parts.join('\n\n')}`
}

function buildRichAgentInput({ promptText, iteration, threshold, injectedUserTurns, transcriptBlocks, windowTurns }) {
  // Reuse the user-turn history section from the current builder, but
  // replace the assistant footer with a rich one.
  const baseline = formatConversationHistory({
    promptText,
    iteration,
    threshold,
    injectedUserTurns,
    assistantTexts: [],
    windowTurns,
  })
  // Strip the placeholder footer the baseline produced for empty assistantTexts.
  const stripped = baseline.replace(/\n\n### assistant \(current iter [^)]+\):\n\(no assistant text yet\)$/m, '')
  return `${stripped}\n\n${formatRichIteration(transcriptBlocks, iteration)}`
}

// ----- Run -----------------------------------------------------------------

const { token, source, masked } = resolveCloneToken()
console.error(`[compare] token source=${source} (${masked})`)
console.error(`[compare] endpoint=${endpoint}`)

const baselineInput = formatConversationHistory({
  promptText,
  iteration: 4,
  threshold: '0.8',
  injectedUserTurns,
  assistantTexts,
  windowTurns: HISTORY_WINDOW_TURNS,
})

const richInput = buildRichAgentInput({
  promptText,
  iteration: 4,
  threshold: '0.8',
  injectedUserTurns,
  transcriptBlocks,
  windowTurns: HISTORY_WINDOW_TURNS,
})

console.log('================================================================')
console.log('BASELINE agent_input (current builder, text-only)')
console.log('================================================================')
console.log(baselineInput)
console.log('\nlength chars:', baselineInput.length)

console.log('\n================================================================')
console.log('RICH agent_input (proposed: + tool_use lines + tool_result summaries)')
console.log('================================================================')
console.log(richInput)
console.log('\nlength chars:', richInput.length)

console.error('\n[compare] calling baseline...')
const baselineResp = await callPredict(token, baselineInput, 'baseline')
console.error('[compare] calling rich...')
const richResp = await callPredict(token, richInput, 'rich')

console.log('\n================================================================')
console.log('BASELINE response')
console.log('================================================================')
console.log(JSON.stringify(baselineResp, null, 2))

console.log('\n================================================================')
console.log('RICH response')
console.log('================================================================')
console.log(JSON.stringify(richResp, null, 2))

console.log('\n================================================================')
console.log('Summary')
console.log('================================================================')
const fmtLine = (label, resp, inputLen) => {
  return [
    `${label}:`,
    `  input chars:        ${inputLen}`,
    `  status:             ${resp.status}`,
    `  confidence:         ${typeof resp.confidence === 'number' ? resp.confidence.toFixed(4) : resp.confidence}`,
    `  predicted_response: ${JSON.stringify(resp.predicted_response)}`,
    `  reasoning:          ${JSON.stringify(resp.reasoning)}`,
    `  model:              ${resp.model}`,
    `  latency_ms:         ${resp.latency_ms}`,
  ].join('\n')
}
console.log(fmtLine('baseline', baselineResp, baselineInput.length))
console.log()
console.log(fmtLine('rich', richResp, richInput.length))
