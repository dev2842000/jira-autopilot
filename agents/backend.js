import { CONFIG } from '../config.js'
import { BACKEND_TOOLS, compactToolResult, executeBackendTool } from '../tools/index.js'
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
  emit('agent:backend', { phase: 'finalizing', reason: lastStopReason })

  const response = await client.messages.create({
    model:      CONFIG.model,
    max_tokens: CONFIG.agentMaxTokens,
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

  emit('agent:backend', { phase: 'raw-output', raw })

  const report = parseJSON(raw)
  if (report) {
    emit('agent:backend', { phase: 'done', report })
    return report
  }

  if (lastStopReason === 'tool_use') {
    return finalizeFromToolBudget({ messages, lastStopReason, emit })
  }

  return {
    status: 'blocked',
    findings: raw || `Backend agent exhausted tool budget before producing a parseable final report. Last stop reason: ${lastStopReason}`,
    changedFiles: [], executedPath: [], payloadObserved: null, verification: [],
    blockers: ['Tool budget exhausted', 'Final report parse error'],
    confidence: 'low',
  }
}

const SYSTEM_PROMPT = `You are a backend developer agent reporting to a tech lead. You can inspect, modify, and verify a Node.js/Express/PostgreSQL backend codebase.

Backend source root: ${CONFIG.paths.backend}

Your fixed skills:
- find_files: find files by filename or path fragment
- read_file: read any file in the backend repo
- write_file: overwrite a backend source file with complete content
- replace_in_file: replace one exact snippet in a backend file
- list_files: explore directory structure
- search_code: search backend source files
- run_command: execute shell commands (curl, node scripts, npm test, etc.) from the backend root
- http_request: make HTTP calls to the running backend server

How you work:
1. Read the task instruction carefully.
2. Explore the codebase to understand the relevant code path.
3. If the task is an implementation task, make the smallest scoped source changes needed.
4. Execute or trigger the relevant backend behaviour.
5. Observe outcomes — log output, HTTP responses, error traces.
6. Report changed files, verification evidence, and blockers honestly.

Rules:
- If the task names a file or concept, use find_files/search_code once or twice to resolve exact paths, then read_file. Do not spend multiple turns listing directories.
- For profile/PIN tasks, search for concrete terms first: "PIN_HASH", "getProfile", "profile", "pin".
- If database credentials or query tooling are unavailable, run the most relevant source-code inspection and return a blocked report with the exact missing env/command evidence.
- Modify files only when the tech lead assigned an implementation or fix task.
- Prefer replace_in_file for targeted edits in large files. Use write_file only for small files or when replacing the full file is truly safer.
- Once you identify the exact old snippet and intended new snippet, call replace_in_file immediately before doing more exploration.
- Do not modify files outside the backend repo root.
- Read a file before overwriting it.
- Preserve existing style and avoid unrelated refactors.
- If a command fails, report the exact error — don't hide it.
- Be specific in your findings: name files, line numbers, function names, payload shapes.
- If you're blocked (e.g. server isn't running), say so clearly.
- Do not fetch or inspect compiled bundles/static build assets. Use source code files and targeted API responses instead.
- After reading relevant endpoint/model files, either make the scoped edits or return a report with exact file paths and remaining blockers. Do not continue generic exploration.
- Keep the final JSON concise. findings must be under 1200 characters.

Output format — respond with valid JSON only:
{
  "status": "ok" | "fail" | "blocked",
  "findings": "concise findings under 1200 chars",
  "changedFiles": ["relative/path"],
  "executedPath": ["file:lineNumber", ...],
  "payloadObserved": <object or null>,
  "verification": ["command or runtime check performed"],
  "blockers": ["description of any blockers"],
  "confidence": "high" | "medium" | "low"
}${playbookSection('backend')}`

export async function runBackendAgent({ task, iteration, emit }) {
  emit('agent:backend', { phase: 'start', iteration, task })

  const messages = [
    { role: 'user', content: `Task (iteration ${iteration}):\n${task}` }
  ]
  emit('agent:backend', { phase: 'prompt', prompt: messages[0].content })

  let lastStopReason = 'not_started'

  // agentic tool-use loop
  for (let turn = 0; turn < CONFIG.maxAgentToolTurns; turn++) {
    const response = await client.messages.create({
      model:      CONFIG.model,
      max_tokens: CONFIG.agentMaxTokens,
      system:     SYSTEM_PROMPT,
      tools:      BACKEND_TOOLS,
      messages,
    })
    lastStopReason = response.stop_reason ?? 'unknown'

    // collect assistant turn
    messages.push({ role: 'assistant', content: response.content })
    emit('agent:backend', { phase: 'assistant', content: compactToolResult(response.content) })

    // check stop reason
    if (response.stop_reason === 'end_turn') {
      // extract final JSON report from last text block
      const textBlock = response.content.findLast(b => b.type === 'text')
      if (!textBlock) break

      const raw = textBlock.text.trim()
      emit('agent:backend', { phase: 'raw-output', raw })

      const report = parseJSON(raw)
      if (report) {
        emit('agent:backend', { phase: 'done', report })
        return report
      }
      // return raw as findings if JSON parse fails
      return { status: 'fail', findings: raw, changedFiles: [], executedPath: [], payloadObserved: null, verification: [], blockers: ['Output parse error'], confidence: 'low' }
    }

    if (response.stop_reason === 'tool_use') {
      // execute all tool calls and collect results
      const toolResults = []

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue

        emit('agent:backend', { phase: 'tool-call', tool: block.name, input: block.input })

        const result = await executeBackendTool(block.name, block.input, (event, data) => {
          emit('agent:backend', { phase: event, ...data })
        })
        const compactResult = compactToolResult(result)

        emit('agent:backend', { phase: 'tool-result', tool: block.name, result: compactResult })

        toolResults.push({
          type:        'tool_result',
          tool_use_id: block.id,
          content:     JSON.stringify(compactResult),
        })
      }

      messages.push({ role: 'user', content: toolResults })
      continue
    }

    // unexpected stop
    emit('agent:backend', { phase: 'unexpected-stop', stopReason: lastStopReason })
    break
  }

  return {
    status: 'blocked',
    findings: `Backend agent stopped before a final report. Last stop reason: ${lastStopReason}`,
    changedFiles: [], executedPath: [], payloadObserved: null, verification: [], blockers: [`Stopped: ${lastStopReason}`], confidence: 'low',
  }
}
