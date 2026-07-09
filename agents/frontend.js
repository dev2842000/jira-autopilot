import { CONFIG } from '../config.js'
import { FRONTEND_TOOLS, compactToolResult, executeFrontendTool } from '../tools/index.js'
import { createAnthropicClient } from './anthropicClient.js'
import { playbookSection } from './playbook.js'

function parseJSON(raw) {
  const stripped = raw.replace(/^```[\w]*\s*/m, '').replace(/\s*```\s*$/m, '').trim()
  try { return JSON.parse(stripped) } catch {}
  const match = stripped.match(/\{[\s\S]*\}/)
  if (match) { try { return JSON.parse(match[0]) } catch {} }
  try { return JSON.parse(raw.trim()) } catch {}
  return null
}

const client = createAnthropicClient()

async function finalizeFromToolBudget({ messages, lastStopReason, emit }) {
  const finalPrompt = `Tool budget is exhausted. Do not call tools. Return the best valid JSON report now using only the evidence already gathered. If implementation is incomplete, status must be "blocked" or "fail" and blockers must explain the exact missing evidence or tool budget issue.`
  emit('agent:frontend', { phase: 'finalizing', reason: lastStopReason })

  const response = await client.messages.create({
    model:      CONFIG.model,
    max_tokens: CONFIG.frontendMaxTokens ?? CONFIG.agentMaxTokens,
    system:     SYSTEM_PROMPT,
    messages: [
      ...messages,
      { role: 'user', content: finalPrompt },
    ],
  })

  const raw = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()

  emit('agent:frontend', { phase: 'raw-output', raw })

  const report = parseJSON(raw)
  if (report) {
    emit('agent:frontend', { phase: 'done', report })
    return report
  }

  return {
    status: 'blocked',
    findings: raw || `Frontend agent exhausted tool budget before producing a parseable final report. Last stop reason: ${lastStopReason}`,
    changedFiles: [], eventReceived: null, eventReceivedAtMs: null, apiCallMade: null, apiCallMethod: null, verification: [],
    blockers: ['Tool budget exhausted', 'Final report parse error'],
    confidence: 'low',
  }
}

const SYSTEM_PROMPT = `You are a frontend developer agent reporting to a tech lead. You can inspect, modify, and verify a React/Next.js/Ionic frontend codebase and monitor live browser behaviour.

Frontend source root: ${CONFIG.paths.frontend}

Your fixed skills:
- find_files: find files by filename or path fragment
- read_file: read any file in the frontend repo
- write_file: overwrite a frontend source file with complete content
- replace_in_file: replace one exact snippet in a frontend file
- list_files: explore directory structure
- search_code: grep across all source files for a pattern
- run_command: execute shell commands (tests, lint, typecheck, targeted scripts) from the frontend root
- monitor_websocket: connect to a WebSocket or SSE endpoint and wait for a specific event
- intercept_api_call: use a headless browser to load a page and confirm a specific API call is made

How you work:
1. Read the task instruction carefully.
2. Explore the codebase to understand where the relevant event handling lives.
3. If the task is an implementation task, make the smallest scoped source changes needed.
4. Set up monitoring (WebSocket listener or browser interceptor) or run tests to observe the actual runtime behaviour.
5. Report exactly what changed and what you received — payload shape, timing, which API call fired (or didn't).

Rules:
- If the task names a file, call find_files for that filename first, then read_file the returned path. Do not spend multiple turns listing directories for named files.
- For this project, target files may be nested. Resolve exact paths for AppsFlyerWrapper.js, protectedRoute.js, and App.js before searching broadly.
- If find_files returns no match for a named target, report that exact blocker immediately with the pattern used.
- Modify files only when the tech lead assigned an implementation or fix task.
- Prefer replace_in_file for targeted edits in App.js, AppsFlyerWrapper.js, and protectedRoute.js. Use write_file only for small files or when replacing the full file is truly safer.
- React Router guard rule: when a parent route uses <Navigate to="X">, you MUST keep a pathname exception for X itself (e.g. location.pathname !== "/pin/set") so the child route can render via <Outlet>. Redirecting to the current path causes a blank page. Removing a guard for one route (e.g. /pin verify) must not remove guards needed for other routes (e.g. /pin/set).
- After routing changes, verify with syntax/build checks only — runtime E2E is the QA agent's job.
- Do not run Cypress, sudo, or browser E2E. The QA agent handles Cypress via run_cypress.
- Once you identify the exact old snippet and intended new snippet, call replace_in_file immediately before doing more exploration.
- Do not modify files outside the frontend repo root.
- Read a file before overwriting it.
- Preserve existing style and avoid unrelated refactors.
- If you time out waiting for an event, say so and report what you found in the code that might explain it.
- Be specific: name files, hook names, event names, API endpoint URLs.
- Report the actual payload you observed, not what you expect it to be.
- Do not read or inspect compiled bundles/static build assets. Use source code files and targeted runtime events instead.
- After reading the target files, either make the scoped edits or return a blocked report with the exact missing path/evidence. Do not continue generic exploration.
- Keep the final JSON concise. findings must be under 1200 characters.

Output format — respond with valid JSON only:
{
  "status": "ok" | "fail" | "blocked",
  "findings": "concise findings under 1200 chars",
  "changedFiles": ["relative/path"],
  "eventReceived": <payload object or null>,
  "eventReceivedAtMs": <number or null>,
  "apiCallMade": <url string or null>,
  "apiCallMethod": <string or null>,
  "verification": ["command or runtime check performed"],
  "blockers": ["description of any blockers"],
  "confidence": "high" | "medium" | "low"
}${playbookSection('frontend')}`

export async function runFrontendAgent({ task, iteration, emit }) {
  emit('agent:frontend', { phase: 'start', iteration, task })

  const messages = [
    { role: 'user', content: `Task (iteration ${iteration}):\n${task}` }
  ]
  emit('agent:frontend', { phase: 'prompt', prompt: messages[0].content })

  let lastStopReason = 'not_started'
  const maxToolTurns = CONFIG.maxFrontendToolTurns ?? CONFIG.maxAgentToolTurns

  for (let turn = 0; turn < maxToolTurns; turn++) {
    const response = await client.messages.create({
      model:      CONFIG.model,
      max_tokens: CONFIG.frontendMaxTokens ?? CONFIG.agentMaxTokens,
      system:     SYSTEM_PROMPT,
      tools:      FRONTEND_TOOLS,
      messages,
    })
    lastStopReason = response.stop_reason ?? 'unknown'

    messages.push({ role: 'assistant', content: response.content })
    emit('agent:frontend', { phase: 'assistant', content: compactToolResult(response.content) })

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.findLast(b => b.type === 'text')
      if (!textBlock) break

      const raw = textBlock.text.trim()
      emit('agent:frontend', { phase: 'raw-output', raw })

      const report = parseJSON(raw)
      if (report) {
        emit('agent:frontend', { phase: 'done', report })
        return report
      }
      return { status: 'fail', findings: raw, changedFiles: [], eventReceived: null, eventReceivedAtMs: null, apiCallMade: null, apiCallMethod: null, verification: [], blockers: ['Output parse error'], confidence: 'low' }
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults = []

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue

        emit('agent:frontend', { phase: 'tool-call', tool: block.name, input: block.input })

        const result = await executeFrontendTool(block.name, block.input, (event, data) => {
          emit('agent:frontend', { phase: event, ...data })
        })
        const compactResult = compactToolResult(result)

        emit('agent:frontend', { phase: 'tool-result', tool: block.name, result: compactResult })

        toolResults.push({
          type:        'tool_result',
          tool_use_id: block.id,
          content:     JSON.stringify(compactResult),
        })
      }

      messages.push({ role: 'user', content: toolResults })
      continue
    }

    emit('agent:frontend', { phase: 'unexpected-stop', stopReason: lastStopReason })
    break
  }

  if (lastStopReason === 'tool_use') {
    return finalizeFromToolBudget({ messages, lastStopReason, emit })
  }

  return {
    status: 'blocked',
    findings: `Frontend agent stopped before a final report. Last stop reason: ${lastStopReason}`,
    changedFiles: [], eventReceived: null, eventReceivedAtMs: null,
    apiCallMade: null, apiCallMethod: null,
    verification: [], blockers: [`Stopped: ${lastStopReason} after ${maxToolTurns} turns`], confidence: 'low',
  }
}
