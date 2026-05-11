#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT
  || resolve(dirname(fileURLToPath(import.meta.url)), '..')

const [, , scriptRelativePath, ...scriptArgs] = process.argv

if (!scriptRelativePath) {
  console.error('Usage: node scripts/run-plugin-bash.mjs <script> [args...]')
  process.exit(1)
}

const scriptPath = resolve(pluginRoot, scriptRelativePath)

if (!existsSync(scriptPath)) {
  console.error(`Plugin bash script not found: ${scriptPath}`)
  process.exit(1)
}

function findBash() {
  const configured = process.env.CLONE_BASH_PATH || process.env.GIT_BASH_PATH
  if (configured && existsSync(configured)) return configured

  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
    ]
    const bash = candidates.find((candidate) => existsSync(candidate))
    if (bash) return bash

    console.error(
      'Git Bash not found. Install Git for Windows or set CLONE_BASH_PATH to Git Bash.',
    )
    process.exit(1)
  }

  return 'bash'
}

const child = spawn(findBash(), [scriptPath, ...scriptArgs], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['pipe', 'inherit', 'inherit'],
  windowsHide: true,
})

process.stdin.pipe(child.stdin)
child.stdin.on('error', () => {})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal)
  })
}

child.on('error', (error) => {
  console.error(error.message)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Plugin bash script terminated by signal ${signal}`)
    process.exit(1)
  }
  process.exit(code ?? 1)
})
