// Three-way comparison against the live Clone MCP endpoint:
//   A: text-only assistant footer (the v1 builder).
//   B: rich footer (current builder) — text + tool_use + tool_result with
//      4-head / 2-tail summaries.
//   C: richer footer — same as B for *every* prior iteration too, with
//      tool_result summaries widened to 8-head / 4-tail.
//
// Same scenario for all three. Prints each agent_input plus prediction.
// Not part of automated tests.

import { resolveCloneToken } from './clone-auth.mjs'
import {
  HISTORY_WINDOW_TURNS,
  formatConversationHistory,
  formatIterationBlocks,
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
    clientInfo: { name: `clone-plugin-compare3-${label}`, version: '0.0.0' },
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
  if (!content || content.type !== 'text') throw new Error(`[${label}] no text content`)
  return JSON.parse(content.text)
}

// ----- Shared scenario -----------------------------------------------------

const promptText = 'Build a small REST API for todos with CRUD endpoints, validation, and tests.'

const injectedUserTurns = [
  { ts: '2026-05-12T10:00:00Z', source: 'clone-prediction', text: 'Add input validation for the POST /todos endpoint.', iteration: 2 },
  { ts: '2026-05-12T10:05:00Z', source: 'auto-answer', text: 'Q: Should we use Zod or Joi for validation?\nA: Zod' },
  { ts: '2026-05-12T10:10:00Z', source: 'clone-prediction', text: 'Now write integration tests for the validation errors.', iteration: 3 },
]

// Per-iteration assistant timelines (text + tool_use + tool_result blocks).
// Iteration 4 is the "current" one. Iterations 2 and 3 are prior — variant C
// renders those too.
const iterationTimelines = {
  2: [
    { kind: 'text', text: 'I will scaffold the routes and a tiny in-memory todo store first.' },
    { kind: 'tool_use', name: 'Write', input: { file_path: 'src/routes/todos.ts' } },
    { kind: 'tool_result', name: 'Write', text: 'File created successfully at: src/routes/todos.ts' },
    { kind: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } },
    { kind: 'tool_result', name: 'Bash', text: 'tests 8\npass 8\nfail 0' },
    { kind: 'text', text: 'Routes scaffolded; smoke tests green. Ready to add Zod validation next.' },
  ],
  3: [
    { kind: 'text', text: 'Adding Zod schemas and wiring validation middleware.' },
    { kind: 'tool_use', name: 'Edit', input: { file_path: 'src/schemas/todo.ts', edits: '+24 / 0' } },
    { kind: 'tool_result', name: 'Edit', text: 'The file src/schemas/todo.ts has been updated successfully.' },
    { kind: 'tool_use', name: 'Edit', input: { file_path: 'src/routes/todos.ts', edits: '+18 / -3' } },
    { kind: 'tool_result', name: 'Edit', text: 'The file src/routes/todos.ts has been updated successfully.' },
    { kind: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } },
    { kind: 'tool_result', name: 'Bash', text: 'tests 14\npass 14\nfail 0' },
    { kind: 'text', text: 'Schemas applied across POST and PATCH. Validation tests pass.' },
  ],
  4: [
    { kind: 'text', text: 'I will start by reading the current routes file to see what is already wired up.' },
    { kind: 'tool_use', name: 'Read', input: { file_path: 'src/routes/todos.ts' } },
    {
      kind: 'tool_result',
      name: 'Read',
      text: '1\timport { Router } from \'express\'\n2\timport { db } from \'../db\'\n3\timport { validate } from \'../middleware/validate\'\n4\timport { TodoCreateSchema, TodoUpdateSchema } from \'../schemas/todo\'\n5\t\n6\tconst router = Router()\n7\trouter.post(\'/\', validate(TodoCreateSchema), async (req, res) => {\n8\t  const todo = await db.todo.create({ data: req.body })\n9\t  res.status(201).json(todo)\n10\t})\n11\trouter.patch(\'/:id\', validate(TodoUpdateSchema), async (req, res) => {\n12\t  const todo = await db.todo.update({ where: { id: req.params.id }, data: req.body })\n13\t  res.json(todo)\n14\t})\n15\trouter.get(\'/\', async (_req, res) => {\n16\t  res.json(await db.todo.findMany())\n17\t})\n18\trouter.get(\'/:id\', async (req, res) => {\n19\t  res.json(await db.todo.findUnique({ where: { id: req.params.id } }))\n20\t})\n21\trouter.delete(\'/:id\', async (req, res) => {\n22\t  await db.todo.delete({ where: { id: req.params.id } })\n23\t  res.status(204).end()\n24\t})\n25\texport default router',
    },
    { kind: 'text', text: 'Now I will add a supertest-based integration test that hits POST /todos with a malformed body and asserts a 400 response with a structured envelope.' },
    { kind: 'tool_use', name: 'Write', input: { file_path: 'tests/routes/todos.test.ts' } },
    {
      kind: 'tool_result',
      name: 'Write',
      text: 'File created successfully at: tests/routes/todos.test.ts\nContents:\nimport request from \'supertest\'\nimport { app } from \'../../src/app\'\nimport { describe, it, expect } from \'vitest\'\n\ndescribe(\'POST /todos validation\', () => {\n  it(\'rejects a body missing required fields\', async () => {\n    const res = await request(app).post(\'/todos\').send({})\n    expect(res.status).toBe(400)\n    expect(res.body.error).toMatchObject({ code: \'invalid_input\' })\n  })\n  it(\'rejects unknown keys\', async () => {\n    const res = await request(app).post(\'/todos\').send({ title: \'ok\', surprise: true })\n    expect(res.status).toBe(400)\n  })\n})',
    },
    { kind: 'tool_use', name: 'Bash', input: { command: 'pnpm test tests/routes/todos.test.ts' } },
    {
      kind: 'tool_result',
      name: 'Bash',
      text: '> clone-claude-plugin-tests@ test\n> vitest run tests/routes/todos.test.ts\n\n RUN  v1.6.0\n\n ✓ tests/routes/todos.test.ts (2)\n   ✓ POST /todos validation (2)\n     ✓ rejects a body missing required fields\n     ✓ rejects unknown keys\n\n Test Files  1 passed (1)\n      Tests  2 passed (2)\n   Duration  812ms\n',
    },
    { kind: 'text', text: 'Integration tests pass. The validation contract is now exercised end-to-end through the express app via supertest.' },
  ],
}

// ----- Variant builders ----------------------------------------------------

function buildA() {
  // Text-only: pull just the text blocks from this-iter timeline.
  const assistantTexts = iterationTimelines[4]
    .filter((b) => b.kind === 'text')
    .map((b) => b.text)
  return formatConversationHistory({
    promptText,
    iteration: 4,
    threshold: '0.8',
    injectedUserTurns,
    assistantTexts,
    windowTurns: HISTORY_WINDOW_TURNS,
  })
}

function buildB() {
  return formatConversationHistory({
    promptText,
    iteration: 4,
    threshold: '0.8',
    injectedUserTurns,
    iterationBlocks: iterationTimelines[4],
    windowTurns: HISTORY_WINDOW_TURNS,
  })
}

// Variant C inserts a "prior iteration timeline" block under each user turn
// that started its iteration. Reuses formatIterationBlocks with widened
// summaries.
function buildC() {
  const richerOptions = { toolResultHead: 8, toolResultTail: 4 }

  // Build the prompt skeleton with B's footer for iteration 4.
  let baseline = formatConversationHistory({
    promptText,
    iteration: 4,
    threshold: '0.8',
    injectedUserTurns,
    iterationBlocks: iterationTimelines[4].map((b) => ({ ...b })),
    windowTurns: HISTORY_WINDOW_TURNS,
  })
  // Re-render iter 4 footer with widened summaries.
  baseline = baseline.replace(
    /### assistant \(current iter 4\):\n[\s\S]*$/,
    `### assistant (current iter 4):\n${formatIterationBlocks(iterationTimelines[4], richerOptions)}`,
  )

  // Insert prior-iteration timelines right after each user (clone-prediction)
  // marker. We map iteration 2 timeline below the first prediction and
  // iteration 3 timeline below the second.
  const priorBlocks = {
    'Add input validation for the POST /todos endpoint.': iterationTimelines[2],
    'Now write integration tests for the validation errors.': iterationTimelines[3],
  }
  for (const [predictionText, blocks] of Object.entries(priorBlocks)) {
    const block = formatIterationBlocks(blocks, richerOptions)
    const labeled = `### assistant (prior iter timeline):\n${block}`
    baseline = baseline.replace(
      `### user (clone-prediction):\n${predictionText}`,
      `### user (clone-prediction):\n${predictionText}\n\n${labeled}`,
    )
  }
  return baseline
}

// ----- Run -----------------------------------------------------------------

const { token, source, masked } = resolveCloneToken()
console.error(`[compare3] token source=${source} (${masked})`)
console.error(`[compare3] endpoint=${endpoint}`)

const RUNS = Number(process.env.COMPARE_RUNS || '5')
const variants = [
  { label: 'A-text-only', input: buildA() },
  { label: 'B-rich-this-iter', input: buildB() },
  { label: 'C-richer-all-iters', input: buildC() },
]

for (const v of variants) {
  console.log('\n================================================================')
  console.log(`${v.label} agent_input  (chars: ${v.input.length})`)
  console.log('================================================================')
  console.log(v.input)
}

console.error(`\n[compare3] calling each variant ${RUNS} times (live MCP)...`)
const runs = []
for (let i = 0; i < RUNS; i += 1) {
  for (const v of variants) {
    const t0 = Date.now()
    let resp
    let err = null
    try {
      resp = await callPredict(token, v.input, v.label)
    } catch (e) {
      err = e?.message || String(e)
    }
    const wallMs = Date.now() - t0
    console.error(`[compare3]   run ${i + 1} / ${v.label}  -> ${err ? `ERR ${err.slice(0, 80)}` : `conf=${resp.confidence?.toFixed(4)} status=${resp.status}`}`)
    runs.push({ run: i + 1, label: v.label, input: v.input, resp, err, wallMs })
  }
}

console.log('\n================================================================')
console.log(`Per-call results (${RUNS} runs per variant)`)
console.log('================================================================')
for (const r of runs) {
  if (r.err) {
    console.log(`\n--- run ${r.run} / ${r.label}  ERROR: ${r.err}`)
    continue
  }
  console.log(`\n--- run ${r.run} / ${r.label}  conf=${r.resp.confidence.toFixed(4)} status=${r.resp.status} latency=${r.resp.latency_ms}ms ---`)
  console.log(`predicted_response: ${JSON.stringify(r.resp.predicted_response)}`)
  console.log(`reasoning:          ${JSON.stringify(r.resp.reasoning)}`)
  if (Array.isArray(r.resp.candidates)) {
    for (const c of r.resp.candidates) {
      console.log(`  - candidate conf=${(c.confidence ?? 0).toFixed(2)}: ${JSON.stringify(c.response).slice(0, 200)}`)
    }
  }
}

// ----- Aggregate -----------------------------------------------------------

function summarizeLabel(label) {
  const slice = runs.filter((r) => r.label === label && !r.err)
  if (!slice.length) return null
  const confs = slice.map((r) => r.resp.confidence).filter((n) => Number.isFinite(n))
  const responses = slice.map((r) => r.resp.predicted_response || '')
  const lengths = responses.map((s) => s.length)
  const autoCount = slice.filter((r) => r.resp.status === 'auto').length
  const escalatedCount = slice.filter((r) => r.resp.status === 'escalated').length
  const uniqueResponses = new Set(responses.map((s) => s.trim().toLowerCase()))
  const mean = confs.reduce((a, b) => a + b, 0) / confs.length
  const sorted = [...confs].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const inputChars = slice[0].input.length
  return {
    label,
    inputChars,
    n: slice.length,
    autoCount,
    escalatedCount,
    confMean: mean,
    confMedian: median,
    confMin: Math.min(...confs),
    confMax: Math.max(...confs),
    respLenMean: lengths.reduce((a, b) => a + b, 0) / lengths.length,
    uniqueResponses: uniqueResponses.size,
    sampleResponses: responses,
  }
}

console.log('\n================================================================')
console.log(`Aggregate (${RUNS} runs per variant)`)
console.log('================================================================')
for (const v of variants) {
  const s = summarizeLabel(v.label)
  if (!s) {
    console.log(`\n${v.label}: all runs errored`)
    continue
  }
  console.log(
    [
      ``,
      `${s.label}:`,
      `  input chars:           ${s.inputChars}`,
      `  successful runs:       ${s.n} / ${RUNS}`,
      `  auto status:           ${s.autoCount} / ${s.n}   (threshold crossed)`,
      `  escalated status:      ${s.escalatedCount} / ${s.n}`,
      `  confidence mean:       ${s.confMean.toFixed(4)}`,
      `  confidence median:     ${s.confMedian.toFixed(4)}`,
      `  confidence range:      ${s.confMin.toFixed(4)} .. ${s.confMax.toFixed(4)}`,
      `  predicted_response avg length (chars): ${s.respLenMean.toFixed(1)}`,
      `  unique predictions:    ${s.uniqueResponses} / ${s.n}`,
      `  samples:`,
      ...s.sampleResponses.map((r, i) => `    ${i + 1}. ${JSON.stringify(r).slice(0, 200)}`),
    ].join('\n'),
  )
}
