import { resolveCloneToken } from './clone-auth.mjs'

const CLIENT_VERSION = '0.3.0'

function endpointUrl() {
  return process.env.CLONE_MCP_URL || 'https://api.clone.is/mcp'
}

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
    try {
      return JSON.parse(frame)
    } catch {}
  }

  return text ? JSON.parse(text) : null
}

async function rpc(method, params, { token, mcpSessionId } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'X-Clone-API-Key': token,
  }
  if (mcpSessionId) headers['mcp-session-id'] = mcpSessionId

  const res = await fetch(endpointUrl(), {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Clone MCP ${method} failed with HTTP ${res.status}: ${text.slice(0, 500)}`)
  }

  return {
    mcpSessionId: res.headers.get('mcp-session-id') || mcpSessionId || '',
    payload: text ? parseSse(text) : null,
  }
}

async function initializeMcp(token) {
  const init = await rpc(
    'initialize',
    {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clone-claude-plugin', version: CLIENT_VERSION },
    },
    { token },
  )
  return init.mcpSessionId
}

function textBody(call, toolName) {
  const content = call.payload?.result?.content?.[0]
  if (!content || content.type !== 'text') {
    throw new Error(`Clone MCP ${toolName} returned no text content.`)
  }
  return JSON.parse(content.text)
}

async function ensureMcpSession({ token, mcpSessionId }) {
  if (mcpSessionId) return mcpSessionId
  return initializeMcp(token)
}

async function callTool(name, args, { token, mcpSessionId }) {
  return rpc('tools/call', { name, arguments: args }, { token, mcpSessionId })
}

export async function clonePredictNextPrompt({ agent, agentInput, threshold, sessionId, mcpSessionId }) {
  const { token } = resolveCloneToken()
  const activeMcp = await ensureMcpSession({ token, mcpSessionId })

  const args = {
    agent,
    agent_input: agentInput,
    k: 1,
    threshold: Number(threshold || '0.8'),
  }
  if (sessionId) args.session_id = sessionId

  const call = await callTool('predict_next_prompt', args, { token, mcpSessionId: activeMcp })
  return { ...textBody(call, 'predict_next_prompt'), mcp_session_id: call.mcpSessionId }
}

export async function startCloneSession({ sourceDetail, mcpSessionId }) {
  const { token } = resolveCloneToken()
  const activeMcp = await ensureMcpSession({ token, mcpSessionId })

  const call = await callTool(
    'start_session',
    {
      source: 'integration',
      source_detail: sourceDetail || 'clone-claude-plugin',
    },
    { token, mcpSessionId: activeMcp },
  )
  const body = textBody(call, 'start_session')
  const cloneSessionId =
    body?.session_id || body?.id || body?.session?.id || body?.session?.session_id
  if (!cloneSessionId) {
    throw new Error(`Clone MCP start_session returned no session id: ${JSON.stringify(body)}`)
  }
  return { cloneSessionId: String(cloneSessionId), mcpSessionId: call.mcpSessionId }
}

export async function stopCloneSession({ cloneSessionId, sourceDetail, mcpSessionId }) {
  if (!cloneSessionId) return null
  const { token } = resolveCloneToken()
  const activeMcp = await ensureMcpSession({ token, mcpSessionId })

  const call = await callTool(
    'stop_session',
    {
      session_id: cloneSessionId,
      source: 'integration',
      source_detail: sourceDetail || 'clone-claude-plugin',
    },
    { token, mcpSessionId: activeMcp },
  )
  return { ...textBody(call, 'stop_session'), mcp_session_id: call.mcpSessionId }
}

export async function recordAgentPrompt({
  cloneSessionId,
  agent,
  prompt,
  source,
  sourceDetail,
  mcpSessionId,
}) {
  if (!cloneSessionId || !prompt) return null
  const { token } = resolveCloneToken()
  const activeMcp = await ensureMcpSession({ token, mcpSessionId })

  const call = await callTool(
    'record_agent_prompt',
    {
      session_id: cloneSessionId,
      agent,
      prompt,
      source: source || 'integration',
      source_detail: sourceDetail || 'clone-claude-plugin',
    },
    { token, mcpSessionId: activeMcp },
  )
  const body = textBody(call, 'record_agent_prompt')
  const eventId = body?.event_id || body?.id || body?.event?.id
  return { eventId: eventId ? String(eventId) : '', mcpSessionId: call.mcpSessionId, body }
}

export async function recordAgentResponse({
  cloneSessionId,
  agent,
  response,
  inResponseTo,
  source,
  sourceDetail,
  mcpSessionId,
}) {
  if (!cloneSessionId || !response) return null
  const { token } = resolveCloneToken()
  const activeMcp = await ensureMcpSession({ token, mcpSessionId })

  const args = {
    session_id: cloneSessionId,
    agent,
    response,
    source: source || 'integration',
    source_detail: sourceDetail || 'clone-claude-plugin',
  }
  if (inResponseTo) args.in_response_to = inResponseTo

  const call = await callTool('record_agent_response', args, { token, mcpSessionId: activeMcp })
  const body = textBody(call, 'record_agent_response')
  const eventId = body?.event_id || body?.id || body?.event?.id
  return { eventId: eventId ? String(eventId) : '', mcpSessionId: call.mcpSessionId, body }
}

export async function submitFeedback({ predictionId, status, mcpSessionId }) {
  if (!predictionId) return null
  const { token } = resolveCloneToken()
  const activeMcp = await ensureMcpSession({ token, mcpSessionId })

  const call = await callTool(
    'submit_feedback',
    {
      prediction_id: predictionId,
      status,
    },
    { token, mcpSessionId: activeMcp },
  )
  return { ...textBody(call, 'submit_feedback'), mcp_session_id: call.mcpSessionId }
}

export { initializeMcp }
