// Helpers for assembling multi-turn conversation context that the Clone Loop
// hooks send to Clone MCP `predict_next_prompt`.
//
// The Stop hook and the AskUserQuestion hook both need the same shape:
//   - the original 1-turn user prompt (always preserved)
//   - all Clone-injected user turns reconstructed from the loop history JSONL
//   - the assistant text emitted during the current iteration
//
// This module is intentionally side-effect free so it can be imported from
// hooks and unit-tested without spinning up a fake MCP server.

import { existsSync, readFileSync } from 'node:fs'

export const HISTORY_WINDOW_TURNS = 20

function safeJsonParse(line) {
  try {
    return JSON.parse(line.replace(/^﻿/, ''))
  } catch {
    return null
  }
}

/**
 * Reads `.claude/clone-loop.history.local.jsonl` and reconstructs the
 * chronological sequence of user turns that Clone has injected during the
 * active loop.
 *
 * Returns an array of `{ts, source, text, iteration?}` sorted by `ts`.
 * Silent on a missing file or unparseable lines.
 */
export function loadInjectedUserTurns(historyPath) {
  if (!historyPath || !existsSync(historyPath)) return []

  let raw
  try {
    raw = readFileSync(historyPath, 'utf8')
  } catch {
    return []
  }

  const turns = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    const record = safeJsonParse(line)
    if (!record || typeof record !== 'object') continue
    const ts = typeof record.ts === 'string' ? record.ts : ''

    if (record.event === 'stop' && record.decision === 'continue') {
      const text = typeof record.predicted_response === 'string' ? record.predicted_response : ''
      if (!text) continue
      turns.push({
        ts,
        source: 'clone-prediction',
        text,
        iteration: record.iteration,
      })
      continue
    }

    if (record.event === 'ask-user-question' && record.decision === 'auto-answer-freeform') {
      const answers = record.answers && typeof record.answers === 'object' ? record.answers : null
      if (!answers) continue
      for (const [question, answer] of Object.entries(answers)) {
        const q = String(question || '').trim()
        const a = String(answer ?? '').trim()
        if (!q && !a) continue
        turns.push({
          ts,
          source: 'auto-answer',
          text: `Q: ${q}\nA: ${a}`,
        })
      }
      continue
    }

    if (record.event === 'ask-user-question' && record.decision === 'auto-answer-fallback-mcp-error') {
      const q = String(record.question || '').trim()
      const a = String(record.answer || '').trim()
      if (!q && !a) continue
      turns.push({
        ts,
        source: 'auto-answer-fallback',
        text: `Q: ${q}\nA: ${a}`,
      })
      continue
    }
  }

  return turns.sort((left, right) => {
    if (left.ts < right.ts) return -1
    if (left.ts > right.ts) return 1
    return 0
  })
}

function detectTimestampField(records) {
  for (const record of records) {
    if (typeof record?.timestamp === 'string') return 'timestamp'
    if (typeof record?.ts === 'string') return 'ts'
  }
  return null
}

function extractAssistantTexts(record) {
  if (record?.message?.role !== 'assistant') return []
  const content = record.message?.content
  if (!Array.isArray(content)) return []
  const texts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
      texts.push(block.text)
    }
  }
  return texts
}

/**
 * Reads the Claude Code transcript JSONL and collects assistant text blocks
 * emitted during the current loop iteration. Throws on JSON parse error so
 * the caller can fall back gracefully.
 *
 * Filtering rules:
 *   - If the records have a recognizable timestamp field (`timestamp` or
 *     `ts`) and `sinceTs` is non-empty, only records with timestamp strictly
 *     greater than `sinceTs` are kept.
 *   - Otherwise (no usable timestamp field OR `sinceTs` empty) all assistant
 *     texts in the transcript are returned (graceful degradation).
 */
export function assistantTextsThisIteration(transcriptPath, sinceTs) {
  if (!transcriptPath) return []
  const raw = readFileSync(transcriptPath, 'utf8')
  const records = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    records.push(JSON.parse(line.replace(/^﻿/, '')))
  }

  const timestampField = detectTimestampField(records)
  const useFilter = Boolean(timestampField) && Boolean(sinceTs)

  const texts = []
  for (const record of records) {
    if (useFilter) {
      const recordTs = record?.[timestampField]
      if (typeof recordTs !== 'string' || recordTs <= sinceTs) continue
    }
    for (const text of extractAssistantTexts(record)) {
      texts.push(text)
    }
  }

  return texts
}

function formatTurn(turn) {
  return `### user (${turn.source}):\n${turn.text}`
}

/**
 * Builds the single-string `agent_input` sent to Clone MCP.
 *
 * Layout:
 *   1. "Original Clone Loop prompt" — the 1-turn user prompt, always preserved.
 *   2. "Conversation history" — the most recent `windowTurns` Clone-injected
 *      user turns (predictions + auto-answers) in chronological order. Drops
 *      oldest first if over the cap.
 *   3. "assistant (current iter N)" — all assistant text emitted during this
 *      iteration, joined. Rendered exactly once and never windowed so the
 *      freshest output cannot be lost.
 */
export function formatConversationHistory({
  promptText,
  iteration,
  threshold,
  injectedUserTurns,
  assistantTexts,
  windowTurns,
}) {
  const safePrompt = String(promptText || '').trim()
  const safeIteration = iteration == null ? '' : String(iteration)
  const safeThreshold = threshold == null ? '' : String(threshold)
  const safeAssistantTexts = Array.isArray(assistantTexts) ? assistantTexts.filter(Boolean) : []
  const safeUserTurns = Array.isArray(injectedUserTurns) ? injectedUserTurns : []
  const cap = Number.isFinite(Number(windowTurns)) && Number(windowTurns) > 0
    ? Number(windowTurns)
    : HISTORY_WINDOW_TURNS

  const trimmedUserTurns = safeUserTurns.length > cap
    ? safeUserTurns.slice(safeUserTurns.length - cap)
    : safeUserTurns

  const historyBlock = trimmedUserTurns.length
    ? trimmedUserTurns.map(formatTurn).join('\n\n')
    : '(no prior user turns)'

  const currentAssistantBlock = safeAssistantTexts.length
    ? safeAssistantTexts.join('\n\n')
    : '(no assistant text yet)'

  return `Original Clone Loop prompt:
${safePrompt}

Clone Loop iteration: ${safeIteration}
Clone threshold: ${safeThreshold}

=== Conversation history (most recent ${cap} user turns) ===

${historyBlock}

### assistant (current iter ${safeIteration}):
${currentAssistantBlock}`
}
