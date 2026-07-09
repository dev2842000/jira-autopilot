import { CONFIG } from '../config.js'
import { createAnthropicClient, cachedSystem } from './anthropicClient.js'
import { fetchJiraTicket, findJiraTicketKey } from './jiraMcp.js'
import { playbookSection } from './playbook.js'

const client = createAnthropicClient()

function parseJSON(raw) {
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

function jiraContextForPrompt(context) {
  if (!context) return null
  return {
    ok: context.ok,
    ticketKey: context.ticketKey,
    toolName: context.toolName,
    argumentName: context.argumentName,
    error: context.error,
    result: context.result,
  }
}

const SYSTEM_PROMPT = `You are a project manager and tech lead pair preparing work for specialist developer agents.

You do NOT write code in this phase. Your job is to convert the user's requirement into an approved implementation roadmap.

Project roots:
- backend: ${CONFIG.paths.backend}
- frontend: ${CONFIG.paths.frontend}
- admin: ${CONFIG.paths.admin}

Create a clear roadmap that a human can review before any developer modifies files.

Rules:
- Separate product requirement from technical approach.
- If Jira context is present and ok=true, use it as the primary product source.
- If Jira context is present and ok=false, include the fetch failure in risks or clarifying questions.
- Include acceptance criteria that can be verified later.
- Assign scoped tasks only to these specialist lanes: frontend, backend, database, integration, qa (Cypress E2E).
- QA lane owns Cypress: check dev server, run specs, write specs under cypress/. Frontend lane does not run Cypress.
- If a lane is not needed, put it in standby.
- Be explicit about risks, unknowns, test plan, and what "done" means.
- For React Router redirect guards, distinguish pathname exceptions by route. Removing a guard for /pin (verify) must not remove the guard for /pin/set (setup) — parent routes must not redirect to themselves or child <Outlet> pages render blank.
- testPlan must include "destination page renders" checks for routing work, not only redirect/syntax/build checks.
- risks should call out ambiguous redirect wording that could cause over-simplification.
- Keep the roadmap concise but complete enough for manual approval.

Output raw JSON only. Do NOT use markdown code fences. Do NOT add explanations. Your response must start with { and end with }.

{
  "status": "ready" | "needs_clarification",
  "source": {
    "type": "manual" | "jira",
    "ticketKey": "string or null",
    "title": "string or null",
    "url": "string or null",
    "fetchedAt": "string or null"
  },
  "requirementSummary": "string",
  "productRequirement": {
    "goal": "string",
    "userImpact": "string",
    "acceptanceCriteria": ["string"]
  },
  "technicalRoadmap": {
    "approach": "string",
    "affectedAreas": ["string"],
    "implementationSteps": ["string"],
    "risks": ["string"],
    "testPlan": ["string"]
  },
  "assignments": {
    "frontend": {"status":"assigned" | "standby", "task":"string"},
    "backend": {"status":"assigned" | "standby", "task":"string"},
    "database": {"status":"assigned" | "standby", "task":"string"},
    "integration": {"status":"assigned" | "standby", "task":"string"},
    "qa": {"status":"assigned" | "standby", "task":"string"}
  },
  "clarifyingQuestions": ["string"]
}${playbookSection('planner')}`

export async function runPlanningAgent({ requirement, emit }) {
  emit('agent:planner', { phase: 'thinking' })

  const ticketKey = findJiraTicketKey(requirement)
  let jiraContext = null

  if (ticketKey) {
    emit('agent:planner', { phase: 'tool-call', tool: 'fetch_jira_ticket', input: { ticketKey } })
    jiraContext = await fetchJiraTicket({ ticketKey })
    emit('agent:planner', { phase: 'tool-result', tool: 'fetch_jira_ticket', result: jiraContext })
  }

  const userMessage = [
    `Requirement:\n${requirement}`,
    jiraContext ? `Jira ticket context:\n${JSON.stringify(jiraContextForPrompt(jiraContext), null, 2)}` : 'Jira ticket context:\nNo Jira ticket key detected in the requirement.',
    'Prepare the PM/TL roadmap for manual approval.',
  ].join('\n\n')
  emit('agent:planner', { phase: 'prompt', prompt: userMessage })

  const response = await client.messages.create({
    model:      CONFIG.model,
    max_tokens: CONFIG.plannerMaxTokens ?? CONFIG.managerMaxTokens,
    system:     cachedSystem(SYSTEM_PROMPT),
    messages:   [
      { role: 'user',      content: userMessage },
      { role: 'assistant', content: '{' },
    ],
  })

  const raw = '{' + response.content
    .map(block => block.type === 'text' ? block.text : JSON.stringify(block))
    .join('\n')
    .trim()

  emit('agent:planner', { phase: 'raw-output', raw })

  const roadmap = parseJSON(raw)
  if (!roadmap) {
    emit('agent:planner', { phase: 'parse-error', raw })
    throw new Error(`Planning agent returned unparseable response: ${raw.slice(0, 300)}`)
  }

  emit('agent:planner', { phase: 'roadmap', roadmap })
  return roadmap
}
