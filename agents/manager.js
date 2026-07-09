import { CONFIG } from '../config.js'
import { createAnthropicClient, cachedSystem } from './anthropicClient.js'
import { playbookSection } from './playbook.js'

const client = createAnthropicClient()

function parseJSON(raw) {
  // try stripping code fences with various patterns
  const attempts = [
    raw.trim(),
    raw.replace(/```[\w]*\n?/g, '').trim(),
    raw.replace(/^[^{]*/, '').replace(/[^}]*$/, ''),
  ]
  for (const attempt of attempts) {
    try { return JSON.parse(attempt) } catch {}
    const match = attempt.match(/\{[\s\S]*\}/)
    if (match) { try { return JSON.parse(match[0]) } catch {} }
  }
  return null
}

const SYSTEM_PROMPT = `You are a tech lead orchestrating specialist developer agents against a human-approved roadmap.

You coordinate implementation, fixes, and validation across frontend, backend, and QA (Cypress) agents. Your job is to make the implementation match the approved roadmap, with evidence, without expanding scope.

CRITICAL: Record your decision by using the record_manager_decision tool. Keep all string fields concise.

On first call or when re-tasking, output exactly this shape:
{"action":"dispatch","reasoning":"string","backendInstruction":"string","frontendInstruction":"string","qaInstruction":"string"}

When complete:
{"action":"done","verdict":"pass","summary":"string","iterations":0}

Rules:
- You never touch code directly. You read the approved roadmap and agent reports, then issue scoped instructions.
- Treat the approved roadmap as the source of truth.
- Be specific: name files, functions, endpoints, event types, tests, and acceptance criteria.
- Cross-reference all agent reports to find mismatches.
- If something is confirmed working, don't re-ask for it.
- Never assign Cypress, smoke tests, or staging test plans to the frontend agent — those go to qaInstruction only.
- qaInstruction is mandatory on every dispatch. Use "Standby: hold until frontend completes" on iteration 0 if needed.
- Do not verdict pass until QA has run Cypress or reported blocked with dev-server-down evidence.
- If QA reports blocked due to Cypress cache/permissions (EACCES), finish with verdict "blocked" and manual QA steps — do NOT re-dispatch QA in a loop.
- For React Router changes, QA must verify target routes render (e.g. /pin/set shows set-pin form) via Cypress or report blocked if dev server down.
- Do not mark pass if QA reports blocked/fail and acceptance criteria are unverified.
- If a lane is not needed, give that agent a clear holding/standby task.
- If PRIOR COMPLETED RUN context is present (re-run after pass), never re-dispatch implementation. Frontend/backend standby only; QA runs Cypress.
- If the approved roadmap is fully satisfied with evidence, finish with verdict "pass".
- If an agent reports a fixable gap, dispatch a targeted follow-up to the right agent.
- If one agent provides high-confidence evidence for a blocking issue, you may finish with verdict "fail" and a specific fix. Do not keep looping only because the other agent is blocked.
- If the same agent is blocked twice, stop and return verdict "blocked" or "fail" with the best diagnosis and the exact missing evidence. Do not re-task the same blocked agent again.
- Prefer a clear partial implementation status over exhausting max iterations.${playbookSection('manager')}`

const MANAGER_DECISION_TOOL = {
  name:        'record_manager_decision',
  description: 'Record the manager decision for the orchestration loop.',
  input_schema: {
    type:       'object',
    properties: {
      action: {
        type:        'string',
        enum:        ['dispatch', 'done'],
        description: 'Use dispatch to task sub-agents, or done to finish the loop.',
      },
      reasoning: {
        type:        'string',
        description: 'Concise reason for the next action. Required for dispatch.',
      },
      backendInstruction: {
        type:        'string',
        description: 'Specific backend task. Required for dispatch.',
      },
      frontendInstruction: {
        type:        'string',
        description: 'Specific frontend implementation task. Required for dispatch.',
      },
      qaInstruction: {
        type:        'string',
        description: 'Specific Cypress QA task, or standby/holding if no E2E work. Required for dispatch.',
      },
      verdict: {
        type:        'string',
        enum:        ['pass', 'fail', 'blocked'],
        description: 'Final verdict. Required for done.',
      },
      summary: {
        type:        'string',
        description: 'Concise final summary. Required for done.',
      },
      iterations: {
        type:        'number',
        description: 'Number of completed iterations. Required for done.',
      },
    },
    required:             ['action'],
    additionalProperties: false,
  },
}

export async function runManagerAgent({ requirement, roadmap, iteration, backendReport, frontendReport, qaReport, historySummary, priorPass, emit }) {
  emit('agent:manager', { phase: 'thinking', iteration })

  const priorPassBlock = priorPass
    ? `\n\nPRIOR COMPLETED RUN (same ticket):\n- sourceRunId: ${priorPass.runId}\n- verdict: ${priorPass.final.verdict}\n- summary: ${priorPass.final.summary}\n\nThis is a RE-RUN after pass. Do NOT dispatch full implementation to frontend/backend again. Dispatch frontend/backend STANDBY (confirm-only reads). Dispatch QA to run Cypress verification. Finish with done/pass once QA confirms or reports blocked (dev server down).`
    : ''

  const userMessage = iteration === 0
    ? `Requirement:\n${requirement}\n\nApproved roadmap:\n${JSON.stringify(roadmap)}\n\nRun history summary:\n${historySummary}${priorPassBlock}\n\nIteration 0. Dispatch scoped tasks or holding tasks. Use the decision tool.`
    : `Requirement:\n${requirement}\n\nApproved roadmap:\n${JSON.stringify(roadmap)}\n\nRun history summary:\n${historySummary}${priorPassBlock}\n\nIteration: ${iteration}\n\nLatest backend report:\n${JSON.stringify(backendReport)}\n\nLatest frontend report:\n${JSON.stringify(frontendReport)}\n\nLatest QA report:\n${JSON.stringify(qaReport)}\n\nUse the decision tool.`

  emit('agent:manager', { phase: 'prompt', prompt: userMessage })

  const response = await client.messages.create({
    model:      CONFIG.model,
    max_tokens: CONFIG.managerMaxTokens,
    system:     cachedSystem(SYSTEM_PROMPT),
    tools:      [MANAGER_DECISION_TOOL],
    tool_choice: {
      type: 'tool',
      name: 'record_manager_decision',
    },
    messages:   [{ role: 'user', content: userMessage }],
  })

  const toolUse = response.content.find(block => block.type === 'tool_use' && block.name === 'record_manager_decision')
  const decision = toolUse?.input ?? parseJSON(response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim())

  if (decision) {
    emit('agent:manager', { phase: 'decision', decision })
    return decision
  }

  const raw = response.content
    .map(block => block.type === 'text' ? block.text : JSON.stringify(block))
    .join('\n')
    .trim()
  emit('agent:manager', { phase: 'parse-error', raw })
  throw new Error(`Manager returned unparseable response: ${raw.slice(0, 300)}`)
}
