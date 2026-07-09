import { CONFIG } from '../config.js'
import { QA_TOOLS, compactToolResult, executeQaTool } from '../tools/index.js'
import { createAnthropicClient } from './anthropicClient.js'
import { playbookSection } from './playbook.js'

function parseJSON(raw) {
  const stripped = raw.replace(/^```[\w]*\s*/m, '').replace(/\s*```\s*$/m, '').trim()
  const attempts = [
    stripped,
    stripped.match(/```json\s*([\s\S]*?)```/i)?.[1]?.trim(),
    stripped.match(/\{[\s\S]*"status"\s*:\s*"(?:ok|fail|blocked)"[\s\S]*\}/)?.[0],
  ].filter(Boolean)
  for (const attempt of attempts) {
    try { return JSON.parse(attempt) } catch {}
  }
  return null
}

function normalizeQaReport(report, raw = '') {
  const text = `${raw} ${report?.findings ?? ''} ${(report?.blockers ?? []).join(' ')}`
  const envBlocked = /EACCES|permission denied|cypress.*cache|cache permission|spawnSync.*ETIMEDOUT|dev server down/i.test(text)
  const nestedBlocked = /"status"\s*:\s*"blocked"/.test(text)

  if (!report) {
    if (envBlocked || nestedBlocked) {
      return {
        status: 'blocked',
        findings: raw.slice(0, 1200) || 'QA blocked by environment; could not parse final JSON.',
        specsRun: [], testsPassed: 0, testsFailed: 0,
        verification: [], blockers: ['Output parse error', 'Cypress environment blocked'],
        confidence: 'medium',
      }
    }
    return null
  }

  if (report.status === 'fail' && (envBlocked || nestedBlocked)) {
    return { ...report, status: 'blocked' }
  }
  if (report.blockers?.includes('Output parse error') && (envBlocked || nestedBlocked)) {
    return { ...report, status: 'blocked', blockers: ['Cypress environment blocked', 'Output parse error'] }
  }
  return report
}

const client = createAnthropicClient()

async function finalizeFromToolBudget({ messages, lastStopReason, emit }) {
  const finalPrompt = `Tool budget is exhausted. Do not call tools. Return the best valid JSON report now using only evidence gathered. If tests did not run, status must be "blocked" or "fail".`
  emit('agent:qa', { phase: 'finalizing', reason: lastStopReason })

  const response = await client.messages.create({
    model:      CONFIG.model,
    max_tokens: CONFIG.qaMaxTokens ?? CONFIG.agentMaxTokens,
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

  emit('agent:qa', { phase: 'raw-output', raw })

  const report = normalizeQaReport(parseJSON(raw), raw)
  if (report) {
    emit('agent:qa', { phase: 'done', report })
    return report
  }

  const fallback = normalizeQaReport(null, raw)
  if (fallback) {
    emit('agent:qa', { phase: 'done', report: fallback })
    return fallback
  }

  return {
    status: 'blocked',
    findings: raw || `QA agent exhausted tool budget. Last stop reason: ${lastStopReason}`,
    specsRun: [], testsPassed: 0, testsFailed: 0, verification: [],
    blockers: ['Tool budget exhausted', 'Final report parse error'],
    confidence: 'low',
  }
}

const SYSTEM_PROMPT = `You are a frontend QA agent specializing in Cypress E2E testing. You report to a tech lead. You verify behaviour — you do not implement product features.

Frontend source root: ${CONFIG.paths.frontend}
Dev server URL: http://localhost:${CONFIG.ports.frontend}

Your tools:
- find_files / read_file / list_files / search_code — inspect specs and config
- write_file — create or update Cypress spec files only (cypress/**)
- check_dev_server — confirm the app is reachable before running tests
- run_cypress — run Cypress headless with safe cache/env defaults (preferred over raw shell)
- run_command — lint specs or one-off checks (never sudo)

Workflow:
1. Read the task: which spec(s) to run, what scenarios to cover, acceptance criteria.
2. check_dev_server first. If down, report blocked with exact URL and manual start command (npm start).
3. Read cypress.config.js and relevant spec(s). Create or extend specs if the task requires new coverage.
4. run_cypress once per spec (or one combined run). Do not retry failed runs with different env hacks.
5. Report pass/fail with test counts, failing test names, and stderr excerpts.

Rules:
- Never run sudo or modify macOS Cypress cache permissions.
- Never implement routing/product fixes in src/ — report failures to the tech lead for the frontend agent.
- Use run_cypress instead of hand-rolling npx cypress commands.
- If Cypress binary missing, run_cypress may install to ${CONFIG.cypress?.cacheFolder ?? '/tmp/cypress-cache'} once; do not loop installs.
- One Cypress run attempt per spec unless the task explicitly asks for a fix-and-rerun cycle.
- Prefer existing npm scripts (cypress:run) via run_cypress when appropriate.
- Be honest: blocked dev server or Cypress env issues → status "blocked", not "fail".
- Keep findings under 1200 characters.

Output format — respond with valid JSON only. No markdown fences. No prose before or after the JSON:
{
  "status": "ok" | "fail" | "blocked",
  "findings": "concise summary under 1200 chars",
  "specsRun": ["cypress/e2e/example.cy.js"],
  "testsPassed": 0,
  "testsFailed": 0,
  "verification": ["check_dev_server → ok", "run_cypress --spec ... → 3 passed"],
  "blockers": ["description"],
  "confidence": "high" | "medium" | "low"
}${playbookSection('qa')}`

export async function runQaAgent({ task, iteration, emit }) {
  emit('agent:qa', { phase: 'start', iteration, task })

  const messages = [
    { role: 'user', content: `Task (iteration ${iteration}):\n${task}` },
  ]
  emit('agent:qa', { phase: 'prompt', prompt: messages[0].content })

  let lastStopReason = 'not_started'
  const maxToolTurns = CONFIG.maxQaToolTurns ?? CONFIG.maxAgentToolTurns

  for (let turn = 0; turn < maxToolTurns; turn++) {
    const response = await client.messages.create({
      model:      CONFIG.model,
      max_tokens: CONFIG.qaMaxTokens ?? CONFIG.agentMaxTokens,
      system:     SYSTEM_PROMPT,
      tools:      QA_TOOLS,
      messages,
    })
    lastStopReason = response.stop_reason ?? 'unknown'

    messages.push({ role: 'assistant', content: response.content })
    emit('agent:qa', { phase: 'assistant', content: compactToolResult(response.content) })

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.findLast(b => b.type === 'text')
      if (!textBlock) break

      const raw = textBlock.text.trim()
      emit('agent:qa', { phase: 'raw-output', raw })

      const report = normalizeQaReport(parseJSON(raw), raw)
      if (report) {
        emit('agent:qa', { phase: 'done', report })
        return report
      }
      const fallback = normalizeQaReport(null, raw)
      if (fallback) {
        emit('agent:qa', { phase: 'done', report: fallback })
        return fallback
      }
      return {
        status: 'blocked', findings: raw.slice(0, 1200), specsRun: [], testsPassed: 0, testsFailed: 0,
        verification: [], blockers: ['Output parse error'], confidence: 'low',
      }
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults = []

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue

        emit('agent:qa', { phase: 'tool-call', tool: block.name, input: block.input })

        const result = await executeQaTool(block.name, block.input, (event, data) => {
          emit('agent:qa', { phase: event, ...data })
        })
        const compactResult = compactToolResult(result)

        emit('agent:qa', { phase: 'tool-result', tool: block.name, result: compactResult })

        toolResults.push({
          type:        'tool_result',
          tool_use_id: block.id,
          content:     JSON.stringify(compactResult),
        })
      }

      messages.push({ role: 'user', content: toolResults })
      continue
    }

    emit('agent:qa', { phase: 'unexpected-stop', stopReason: lastStopReason })
    break
  }

  if (lastStopReason === 'tool_use') {
    return finalizeFromToolBudget({ messages, lastStopReason, emit })
  }

  return {
    status: 'blocked',
    findings: `QA agent stopped before a final report. Last stop reason: ${lastStopReason}`,
    specsRun: [], testsPassed: 0, testsFailed: 0,
    verification: [], blockers: [`Stopped: ${lastStopReason} after ${maxToolTurns} turns`], confidence: 'low',
  }
}
