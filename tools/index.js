import fs   from 'fs'
import path  from 'path'
import { execFileSync, execSync } from 'child_process'
import { CONFIG }   from '../config.js'

// ─── helpers ─────────────────────────────────────────────────────────────────

const MAX_TOOL_TEXT_CHARS = CONFIG.maxToolTextChars ?? 4000

function resolvePath(repoKey, filePath) {
  const base = path.resolve(CONFIG.paths[repoKey])
  const full = path.resolve(base, filePath)
  // safety: don't let agent escape repo root
  if (!full.startsWith(base)) throw new Error(`Path escape attempt: ${filePath}`)
  return full
}

function truncateText(text, maxChars = MAX_TOOL_TEXT_CHARS) {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars; original length ${text.length}]`
}

export function compactToolResult(value, maxChars = MAX_TOOL_TEXT_CHARS) {
  if (typeof value === 'string') return truncateText(value, maxChars)
  if (Array.isArray(value)) return value.map(item => compactToolResult(item, maxChars))
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, compactToolResult(entry, maxChars)])
  )
}

function findFiles(repoKey, pattern = '') {
  const base = path.resolve(CONFIG.paths[repoKey])
  const needle = String(pattern).toLowerCase()

  try {
    const out = execFileSync('rg', ['--files'], {
      cwd: base, encoding: 'utf8', stdio: ['pipe','pipe','pipe'],
    })
    const matches = out
      .split('\n')
      .filter(Boolean)
      .filter(filePath => filePath.toLowerCase().includes(needle))
      .slice(0, 50)

    return { ok: true, pattern, matches }
  } catch (e) {
    return {
      ok: false,
      pattern,
      error: e.message,
      stdout: e.stdout ? truncateText(e.stdout) : undefined,
      stderr: e.stderr ? truncateText(e.stderr, 1000) : undefined,
    }
  }
}

function replaceInFile(repoKey, input) {
  const full = resolvePath(repoKey, input.file_path)
  const content = fs.readFileSync(full, 'utf8')
  const occurrences = content.split(input.old_string).length - 1

  if (occurrences !== 1) {
    return {
      ok: false,
      file_path: input.file_path,
      occurrences,
      error: `Expected old_string to appear exactly once, found ${occurrences}.`,
    }
  }

  const next = content.replace(input.old_string, input.new_string)
  fs.writeFileSync(full, next)

  return {
    ok: true,
    file_path: input.file_path,
    occurrences,
    bytesBefore: Buffer.byteLength(content),
    bytesAfter: Buffer.byteLength(next),
  }
}

// ─── tool definitions (passed to Claude API as tools array) ──────────────────

export const BACKEND_TOOLS = [
  {
    name: 'find_files',
    description: 'Find backend files by filename or path fragment. Use this before reading when you only know a filename.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Filename or path fragment e.g. profile, user.service, App.js' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file from the backend repository. Use relative paths from repo root.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Relative path e.g. src/services/transfer.service.ts' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'write_file',
    description: 'Overwrite a source file in the backend repository. Use only for assigned implementation tasks and provide the complete file content.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Relative path from backend repo root.' },
        content:   { type: 'string', description: 'Complete replacement file content.' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'replace_in_file',
    description: 'Replace one exact text snippet in a backend file. Prefer this for targeted edits in large files.',
    input_schema: {
      type: 'object',
      properties: {
        file_path:  { type: 'string', description: 'Relative path from backend repo root.' },
        old_string: { type: 'string', description: 'Exact existing text to replace. Must appear exactly once.' },
        new_string: { type: 'string', description: 'Replacement text.' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'list_files',
    description: 'List files/folders in a backend directory.',
    input_schema: {
      type: 'object',
      properties: {
        dir_path: { type: 'string', description: 'Relative directory path, or "." for root' },
      },
      required: ['dir_path'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command against the backend. Use for curl, node scripts, npm test, etc. Working dir is the backend repo root.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeout_ms: { type: 'number', description: 'Max time in ms. Default 15000.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'search_code',
    description: 'Search for a text pattern across backend source files. Returns matching lines with file + line number.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search string or regex pattern' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'http_request',
    description: 'Make an HTTP request to the backend server.',
    input_schema: {
      type: 'object',
      properties: {
        method:  { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        path:    { type: 'string', description: 'Path e.g. /api/transfers/123/complete' },
        body:    { type: 'object', description: 'JSON body (optional)' },
        headers: { type: 'object', description: 'Extra headers (optional)' },
      },
      required: ['method', 'path'],
    },
  },
]

export const FRONTEND_TOOLS = [
  {
    name: 'find_files',
    description: 'Find frontend files by filename or path fragment. Use this before reading when you only know a filename.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Filename or path fragment e.g. AppsFlyerWrapper.js, protectedRoute.js, App.js' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file from the frontend repository.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Relative path e.g. src/hooks/useWebhook.ts' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'write_file',
    description: 'Overwrite a source file in the frontend repository. Use only for assigned implementation tasks and provide the complete file content.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Relative path from frontend repo root.' },
        content:   { type: 'string', description: 'Complete replacement file content.' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'replace_in_file',
    description: 'Replace one exact text snippet in a frontend file. Prefer this for targeted edits in large files.',
    input_schema: {
      type: 'object',
      properties: {
        file_path:  { type: 'string', description: 'Relative path from frontend repo root.' },
        old_string: { type: 'string', description: 'Exact existing text to replace. Must appear exactly once.' },
        new_string: { type: 'string', description: 'Replacement text.' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'list_files',
    description: 'List files/folders in a frontend directory.',
    input_schema: {
      type: 'object',
      properties: {
        dir_path: { type: 'string', description: 'Relative directory path, or "." for root' },
      },
      required: ['dir_path'],
    },
  },
  {
    name: 'search_code',
    description: 'Search for a text pattern across all frontend source files. Returns matching lines with file + line number.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search string or regex pattern' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command against the frontend. Use for tests, lint, typecheck, or targeted scripts. Working dir is the frontend repo root.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeout_ms: { type: 'number', description: 'Max time in ms. Default 15000.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'monitor_websocket',
    description: 'Connect to the frontend WebSocket/SSE and listen for a specific event type for up to timeout_ms. Returns the payload if received.',
    input_schema: {
      type: 'object',
      properties: {
        url:         { type: 'string', description: 'WS or SSE URL to connect to' },
        event_type:  { type: 'string', description: 'Event name or message type to wait for' },
        timeout_ms:  { type: 'number', description: 'How long to wait in ms. Default 8000.' },
      },
      required: ['url', 'event_type'],
    },
  },
  {
    name: 'intercept_api_call',
    description: 'Use a headless browser to load the frontend and watch for a specific API call being made after an event fires. Returns request details if caught.',
    input_schema: {
      type: 'object',
      properties: {
        page_url:        { type: 'string', description: 'Frontend page to load e.g. http://localhost:5173/dashboard' },
        request_pattern: { type: 'string', description: 'URL pattern to watch for e.g. /api/balance' },
        trigger_event:   { type: 'string', description: 'Description of what triggers it (for logging)' },
        timeout_ms:      { type: 'number', description: 'Max wait in ms. Default 10000.' },
      },
      required: ['page_url', 'request_pattern'],
    },
  },
]

export const QA_TOOLS = [
  {
    name: 'find_files',
    description: 'Find Cypress spec or config files by filename fragment.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'e.g. routing-fix, cypress.config, e2e' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file from the frontend repo (specs, cypress.config.js, package.json).',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Relative path e.g. cypress/e2e/login.cy.js' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a Cypress spec under cypress/ only.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Must be under cypress/ e.g. cypress/e2e/my-test.cy.js' },
        content:   { type: 'string', description: 'Complete spec file content.' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'list_files',
    description: 'List files in a directory (e.g. cypress/e2e).',
    input_schema: {
      type: 'object',
      properties: {
        dir_path: { type: 'string', description: 'Relative directory path, or "." for root' },
      },
      required: ['dir_path'],
    },
  },
  {
    name: 'search_code',
    description: 'Search frontend source or cypress specs for a pattern.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search string or regex pattern' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'check_dev_server',
    description: `Check whether the frontend dev server responds at http://localhost:${CONFIG.ports.frontend}. Call this before run_cypress.`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'run_cypress',
    description: 'Run Cypress headless with safe cache/env defaults. Prefer this over raw shell commands.',
    input_schema: {
      type: 'object',
      properties: {
        spec:        { type: 'string', description: 'Spec path e.g. cypress/e2e/routing-fix-verification.cy.js' },
        timeout_ms:  { type: 'number', description: 'Max time in ms. Default from config.' },
        install_if_missing: { type: 'boolean', description: 'Run cypress install if binary missing. Default true.' },
      },
      required: ['spec'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a safe shell command from the frontend root (no sudo). Use for spec lint or listing tests.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command — sudo is blocked' },
        timeout_ms: { type: 'number', description: 'Max time in ms. Default 15000.' },
      },
      required: ['command'],
    },
  },
]

// ─── tool executors ──────────────────────────────────────────────────────────

export async function executeBackendTool(toolName, input, emit) {
  emit(`tool:${toolName}`, input)

  try {
    switch (toolName) {
      case 'find_files': {
        return findFiles('backend', input.pattern)
      }

      case 'read_file': {
        const full = resolvePath('backend', input.file_path)
        const content = fs.readFileSync(full, 'utf8')
        return { ok: true, content: truncateText(content), lines: content.split('\n').length }
      }

      case 'write_file': {
        const full = resolvePath('backend', input.file_path)
        fs.mkdirSync(path.dirname(full), { recursive: true })
        fs.writeFileSync(full, input.content)
        return { ok: true, file_path: input.file_path, bytes: Buffer.byteLength(input.content) }
      }

      case 'replace_in_file': {
        return replaceInFile('backend', input)
      }

      case 'list_files': {
        const full = resolvePath('backend', input.dir_path)
        const entries = fs.readdirSync(full, { withFileTypes: true })
        return {
          ok: true,
          entries: entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })),
        }
      }

      case 'run_command': {
        const cwd  = path.resolve(CONFIG.paths.backend)
        const timeout = input.timeout_ms ?? 15_000
        try {
          const stdout = execSync(input.command, { cwd, timeout, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] })
          return { ok: true, stdout: truncateText(stdout) }
        } catch (e) {
          return {
            ok:     false,
            error:  e.message,
            stdout: e.stdout ? truncateText(e.stdout) : undefined,
            stderr: e.stderr ? truncateText(e.stderr, 1000) : undefined,
          }
        }
      }

      case 'search_code': {
        const base = path.resolve(CONFIG.paths.backend)
        try {
          const out = execFileSync('rg', ['-n', '--glob', '*.{ts,tsx,js,jsx}', input.pattern, '.'], {
            cwd: base, encoding: 'utf8', stdio: ['pipe','pipe','pipe'],
          })
          return { ok: true, matches: truncateText(out, 6000) }
        } catch (e) {
          return { ok: true, matches: e.stdout ? truncateText(e.stdout, 6000) : '(no matches)' }
        }
      }

      case 'http_request': {
        const base = `http://localhost:${CONFIG.ports.backend}`
        const res  = await fetch(`${base}${input.path}`, {
          method:  input.method,
          headers: { 'Content-Type': 'application/json', ...(input.headers ?? {}) },
          body:    input.body ? JSON.stringify(input.body) : undefined,
        })
        const text = await res.text()
        let body
        try { body = JSON.parse(text) } catch { body = text }
        return { ok: true, status: res.status, body: compactToolResult(body) }
      }

      default:
        return { ok: false, error: `Unknown tool: ${toolName}` }
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

export async function executeFrontendTool(toolName, input, emit) {
  emit(`tool:${toolName}`, input)

  try {
    switch (toolName) {
      case 'find_files': {
        return findFiles('frontend', input.pattern)
      }

      case 'read_file': {
        const full = resolvePath('frontend', input.file_path)
        const content = fs.readFileSync(full, 'utf8')
        return { ok: true, content: truncateText(content), lines: content.split('\n').length }
      }

      case 'write_file': {
        const full = resolvePath('frontend', input.file_path)
        fs.mkdirSync(path.dirname(full), { recursive: true })
        fs.writeFileSync(full, input.content)
        return { ok: true, file_path: input.file_path, bytes: Buffer.byteLength(input.content) }
      }

      case 'replace_in_file': {
        return replaceInFile('frontend', input)
      }

      case 'list_files': {
        const full = resolvePath('frontend', input.dir_path)
        const entries = fs.readdirSync(full, { withFileTypes: true })
        return {
          ok: true,
          entries: entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })),
        }
      }

      case 'search_code': {
        const base = path.resolve(CONFIG.paths.frontend)
        try {
          const out = execFileSync('rg', ['-n', '--glob', '*.{ts,tsx,js,jsx}', input.pattern, '.'], {
            cwd: base, encoding: 'utf8', stdio: ['pipe','pipe','pipe'],
          })
          return { ok: true, matches: truncateText(out, 6000) }
        } catch (e) {
          return { ok: true, matches: e.stdout ? truncateText(e.stdout, 6000) : '(no matches)' }
        }
      }

      case 'run_command': {
        const cwd  = path.resolve(CONFIG.paths.frontend)
        const timeout = input.timeout_ms ?? 15_000
        try {
          const stdout = execSync(input.command, { cwd, timeout, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] })
          return { ok: true, stdout: truncateText(stdout) }
        } catch (e) {
          return {
            ok:     false,
            error:  e.message,
            stdout: e.stdout ? truncateText(e.stdout) : undefined,
            stderr: e.stderr ? truncateText(e.stderr, 1000) : undefined,
          }
        }
      }

      case 'monitor_websocket': {
        // Native WebSocket monitoring via ws package (falls back to polling SSE)
        const timeout = input.timeout_ms ?? 8_000
        return await monitorWS(input.url, input.event_type, timeout)
      }

      case 'intercept_api_call': {
        const timeout = input.timeout_ms ?? 10_000
        return await interceptWithPlaywright(input.page_url, input.request_pattern, timeout, emit)
      }

      default:
        return { ok: false, error: `Unknown tool: ${toolName}` }
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

async function checkDevServer(port = CONFIG.ports.frontend) {
  const url = `http://localhost:${port}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) })
    return { ok: true, url, status: res.status }
  } catch (err) {
    return {
      ok: false,
      url,
      error: err.message,
      hint: `Start the app: cd ${CONFIG.paths.frontend} && npm start`,
    }
  }
}

function assertSafeCommand(command = '') {
  if (/\bsudo\b/i.test(command)) {
    throw new Error('sudo is not allowed for QA agents')
  }
}

function buildCypressRuntimeEnv() {
  const cache = path.resolve(CONFIG.cypress?.cacheFolder ?? '/tmp/cypress-cache')
  const home = path.join(cache, 'runner-home')
  // Redirect macOS Application Support (Cypress cy/production/cache) away from ~/Library
  fs.mkdirSync(path.join(home, 'Library', 'Application Support', 'Cypress', 'cy', 'production'), { recursive: true })
  fs.mkdirSync(cache, { recursive: true })
  return {
    ...process.env,
    CYPRESS_CACHE_FOLDER: cache,
    HOME: home,
  }
}

function runCypressCommand({ spec, timeout_ms, install_if_missing = true }) {
  const cwd = path.resolve(CONFIG.paths.frontend)
  const browser = CONFIG.cypress?.browser ?? 'electron'
  const timeout = timeout_ms ?? CONFIG.cypress?.defaultTimeoutMs ?? 180_000
  const env = buildCypressRuntimeEnv()

  const specPath = path.resolve(cwd, spec)
  if (!specPath.startsWith(cwd)) {
    return { ok: false, error: `Invalid spec path: ${spec}` }
  }
  if (!fs.existsSync(specPath)) {
    return { ok: false, error: `Spec not found: ${spec}` }
  }

  const execOpts = { cwd, timeout, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env }

  if (install_if_missing) {
    try {
      execSync('npx cypress verify', execOpts)
    } catch {
      try {
        execSync('npx cypress install', { ...execOpts, timeout: 120_000 })
      } catch (e) {
        return {
          ok: false,
          error: `Cypress install failed: ${e.message}`,
          stdout: e.stdout ? truncateText(e.stdout) : undefined,
          stderr: e.stderr ? truncateText(e.stderr, 1000) : undefined,
          envHome: env.HOME,
        }
      }
    }
  }

  const cmd = `npx cypress run --spec ${spec} --headless --browser ${browser}`
  try {
    const stdout = execSync(cmd, execOpts)
    return { ok: true, command: cmd, envHome: env.HOME, stdout: truncateText(stdout) }
  } catch (e) {
    return {
      ok:      false,
      command: cmd,
      envHome: env.HOME,
      error:   e.message,
      stdout:  e.stdout ? truncateText(e.stdout) : undefined,
      stderr:  e.stderr ? truncateText(e.stderr, 2000) : undefined,
    }
  }
}

export async function executeQaTool(toolName, input, emit) {
  emit(`tool:${toolName}`, input)

  try {
    switch (toolName) {
      case 'find_files':
        return findFiles('frontend', input.pattern)

      case 'read_file': {
        const full = resolvePath('frontend', input.file_path)
        const content = fs.readFileSync(full, 'utf8')
        return { ok: true, content: truncateText(content), lines: content.split('\n').length }
      }

      case 'write_file': {
        if (!String(input.file_path).startsWith('cypress/')) {
          return { ok: false, error: 'QA agent may only write files under cypress/' }
        }
        const full = resolvePath('frontend', input.file_path)
        fs.mkdirSync(path.dirname(full), { recursive: true })
        fs.writeFileSync(full, input.content)
        return { ok: true, file_path: input.file_path, bytes: Buffer.byteLength(input.content) }
      }

      case 'list_files': {
        const full = resolvePath('frontend', input.dir_path)
        const entries = fs.readdirSync(full, { withFileTypes: true })
        return {
          ok: true,
          entries: entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })),
        }
      }

      case 'search_code': {
        const base = path.resolve(CONFIG.paths.frontend)
        try {
          const out = execFileSync('rg', ['-n', '--glob', '*.{ts,tsx,js,jsx}', input.pattern, '.'], {
            cwd: base, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
          })
          return { ok: true, matches: truncateText(out, 6000) }
        } catch (e) {
          return { ok: true, matches: e.stdout ? truncateText(e.stdout, 6000) : '(no matches)' }
        }
      }

      case 'check_dev_server':
        return checkDevServer()

      case 'run_cypress':
        return runCypressCommand(input)

      case 'run_command': {
        assertSafeCommand(input.command)
        const cwd = path.resolve(CONFIG.paths.frontend)
        const timeout = input.timeout_ms ?? 15_000
        try {
          const stdout = execSync(input.command, { cwd, timeout, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
          return { ok: true, stdout: truncateText(stdout) }
        } catch (e) {
          return {
            ok:     false,
            error:  e.message,
            stdout: e.stdout ? truncateText(e.stdout) : undefined,
            stderr: e.stderr ? truncateText(e.stderr, 1000) : undefined,
          }
        }
      }

      default:
        return { ok: false, error: `Unknown tool: ${toolName}` }
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

// ─── WS monitor ──────────────────────────────────────────────────────────────

async function monitorWS(url, eventType, timeoutMs) {
  // dynamic import so ws is optional
  try {
    const { default: WebSocket } = await import('ws')
    return await new Promise((resolve) => {
      const ws = new WebSocket(url)
      const timer = setTimeout(() => {
        ws.close()
        resolve({ ok: false, error: `Timeout after ${timeoutMs}ms — event "${eventType}" never arrived` })
      }, timeoutMs)

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString())
          if (msg.type === eventType || msg.event === eventType) {
            clearTimeout(timer)
            ws.close()
            resolve({ ok: true, payload: msg, receivedAt: Date.now() })
          }
        } catch {}
      })

      ws.on('error', (e) => {
        clearTimeout(timer)
        resolve({ ok: false, error: e.message })
      })
    })
  } catch {
    return { ok: false, error: 'ws package not installed — run: npm install ws' }
  }
}

// ─── Playwright interceptor ──────────────────────────────────────────────────

async function interceptWithPlaywright(pageUrl, requestPattern, timeoutMs, emit) {
  try {
    const { chromium } = await import('playwright')
    emit('log', `Launching headless browser → ${pageUrl}`)

    const browser = await chromium.launch({ headless: true })
    const page    = await browser.newPage()

    const caught = await Promise.race([
      page.goto(pageUrl, { waitUntil: 'networkidle' }).then(() =>
        page.waitForRequest(req => req.url().includes(requestPattern), { timeout: timeoutMs })
          .then(req => ({ ok: true, url: req.url(), method: req.method(), postData: req.postData() }))
          .catch(() => ({ ok: false, error: `No request matching "${requestPattern}" within ${timeoutMs}ms` }))
      ),
      new Promise(r => setTimeout(() => r({ ok: false, error: 'Page load timeout' }), timeoutMs + 5000)),
    ])

    await browser.close()
    return caught
  } catch (e) {
    if (e.message.includes('Cannot find module')) {
      return { ok: false, error: 'Playwright not installed — run: npm install playwright && npx playwright install chromium' }
    }
    return { ok: false, error: e.message }
  }
}
