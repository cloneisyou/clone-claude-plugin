#!/usr/bin/env node

import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { stopCloneSession } from './clone-mcp.mjs'

const claudeDir = join(process.cwd(), '.claude')
const statePath = join(claudeDir, 'clone-loop.local.md')
const historyPath = join(claudeDir, 'clone-loop.history.local.jsonl')

if (!existsSync(statePath)) {
  console.log('No active Clone Loop found.')
  process.exit(0)
}

const raw = readFileSync(statePath, 'utf8')
const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
const frontmatter = {}
if (match) {
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator < 0) continue
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    }
    frontmatter[key] = value
  }
}

const iteration = frontmatter.iteration || 'unknown'
const cloneSessionId = frontmatter.clone_session_id || ''
const mcpSessionId = frontmatter.mcp_session_id || ''

if (cloneSessionId) {
  try {
    await stopCloneSession({
      cloneSessionId,
      mcpSessionId,
      sourceDetail: 'clone-loop:cancel',
    })
    try {
      appendFileSync(
        historyPath,
        `${JSON.stringify({
          ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          event: 'session-stopped',
          reason: 'cancel',
          clone_session_id: cloneSessionId,
        })}\n`,
      )
    } catch {}
  } catch (error) {
    console.error(
      `Clone Loop: Failed to stop Clone session (${error?.message || String(error)}); removing state anyway.`,
    )
  }
}

rmSync(statePath, { force: true })

try {
  appendFileSync(
    historyPath,
    `${JSON.stringify({
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      event: 'cancel',
      iteration,
    })}\n`,
  )
} catch {}

console.log(`Cancelled Clone Loop (was at iteration ${iteration}).`)
