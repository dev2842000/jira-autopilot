import express  from 'express'
import cors     from 'cors'
import path     from 'path'
import { fileURLToPath } from 'url'
import { CONFIG }        from './config.js'
import { runPlanningAgent } from './agents/planner.js'
import { runManagerAgent }  from './agents/manager.js'
import { runBackendAgent }  from './agents/backend.js'
import { runFrontendAgent } from './agents/frontend.js'
import { runQaAgent }      from './agents/qa.js'
import {
  appendRunEvent,
  createRunHistory,
  findReusableRunMemory,
  recordApproval,
  recordFinal,
  recordIterationReports,
  recordIterationStart,
  recordManagerDecision,
  recordRoadmap,
  summarizeHistory,
} from './history.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ─── SSE broadcast ────────────────────────────────────────────────────────────

const clients = new Set()
const pendingApprovals = new Map()

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify({ ts: Date.now(), ...data })}\n\n`
  for (const res of clients) {
    try { res.write(payload) } catch {}
  }
}

// typed emit helper passed to agents
function makeEmit(runId, historyFile) {
  return (event, data = {}) => {
    const maxLogChars = event.includes('tool-result') || event.includes('error') ? 2000 : 300
    console.log(`[${runId}] ${event}`, JSON.stringify(data).slice(0, maxLogChars))
    appendRunEvent(historyFile, event, data)
    broadcast(event, { runId, ...data })
  }
}

// ─── core loop ───────────────────────────────────────────────────────────────

function waitForApproval(runId, roadmap, emit) {
  emit('run:approval-required', { roadmap })

  return new Promise(resolve => {
    pendingApprovals.set(runId, {
      roadmap,
      resolve,
      requestedAt: Date.now(),
    })
  })
}

function isHoldingTask(instruction = '') {
  return /\b(hold|holding|idle|standby|no backend|no frontend|no qa|not needed|skip backend|skip frontend|skip qa|minimal holding task)\b/i.test(instruction)
}

function resolveQaInstruction({ decision, roadmap, iteration, frontendReport }) {
  if (decision.qaInstruction?.trim()) {
    return decision.qaInstruction.trim()
  }

  const qaAssignment = roadmap?.assignments?.qa
  if (qaAssignment?.status === 'assigned' && qaAssignment.task?.trim()) {
    return qaAssignment.task.trim()
  }

  const hasFrontendChanges = (frontendReport?.changedFiles?.length ?? 0) > 0
  if (iteration >= 1 || hasFrontendChanges) {
    return [
      'Run Cypress E2E verification for the approved roadmap acceptance criteria.',
      '1) check_dev_server at localhost:3000 — report blocked if down.',
      '2) find or create specs under cypress/e2e/.',
      '3) run_cypress on relevant spec(s) once. Report testsPassed/testsFailed.',
    ].join(' ')
  }

  return 'Standby: hold until frontend implementation is ready for Cypress verification.'
}

function enforceVerifyOnlyRerun(decision, { priorPass, iteration, roadmap, frontendReport, emit }) {
  if (!priorPass || decision.action !== 'dispatch') return decision

  const fe = decision.frontendInstruction ?? ''
  const looksLikeImplementation = /\b(implement|fix onboarding|refactor|modify|replace|remove|write_file|three-file|AppsFlyerWrapper|protectedRoute)\b/i.test(fe)
    && !/\b(standby|hold|confirm fixes still present|read-only|no changedFiles)\b/i.test(fe)

  if (!looksLikeImplementation) return decision

  const qaInstruction = decision.qaInstruction?.trim()
    || resolveQaInstruction({ decision, roadmap, iteration, frontendReport })

  emit('run:verify-only-override', {
    reason: 'Prior run passed for this ticket; blocking repeat implementation dispatch.',
    sourceRunId: priorPass.runId,
  })

  return {
    ...decision,
    frontendInstruction: 'Standby: a prior run already passed for this ticket. Do NOT modify src/. Optionally read App.js, AppsFlyerWrapper.js, protectedRoute.js to confirm fixes are still present. Report ok with changedFiles:[] if unchanged.',
    backendInstruction: isHoldingTask(decision.backendInstruction ?? '')
      ? decision.backendInstruction
      : 'Standby: prior run passed — no backend changes unless QA reports API discrepancy.',
    qaInstruction,
  }
}

function normalizeDispatchDecision(decision, { roadmap, iteration, frontendReport, priorPass, emit }) {
  if (decision.action !== 'dispatch') return decision

  let normalized = priorPass
    ? enforceVerifyOnlyRerun(decision, { priorPass, iteration, roadmap, frontendReport, emit })
    : decision

  if (!normalized.qaInstruction?.trim()) {
    const qaInstruction = resolveQaInstruction({ decision: normalized, roadmap, iteration, frontendReport })
    emit('run:qa-fallback', {
      reason: 'Manager omitted qaInstruction; orchestrator filled a default QA task.',
      qaInstruction,
    })
    return { ...normalized, qaInstruction }
  }

  return normalized
}

function isQaEnvironmentBlocked(qaReport) {
  if (!qaReport || qaReport.status !== 'blocked') return false
  const text = `${qaReport.findings ?? ''} ${(qaReport.blockers ?? []).join(' ')}`
  return /EACCES|permission|cypress.*cache|cache permission|dev server down/i.test(text)
}

function buildManualQaSummary({ qaReport, frontendReport, priorPass }) {
  const spec = qaReport?.specsRun?.[0]
    || (qaReport?.verification ?? []).find(v => /cypress\/e2e\//.test(v))?.match(/cypress\/e2e\/[^\s"]+/)?.[0]
    || 'cypress/e2e/routing-smoke-test.cy.js'
  return [
    priorPass ? 'Re-verification run: code fixes confirmed present.' : 'Implementation verified in source.',
    frontendReport?.findings ? `Frontend: ${frontendReport.findings.slice(0, 200)}` : '',
    `Automated Cypress blocked (environment). Manual QA required: load /new and /pin/set in browser — pages must render content, not blank.`,
    `Optional: run \`cd crobo-web && npx cypress run --spec ${spec}\` locally after fixing Cypress cache permissions.`,
  ].filter(Boolean).join(' ')
}

async function runQaOrSkip({ instruction, iteration, emit }) {
  if (!isHoldingTask(instruction)) {
    return runQaAgent({ task: instruction, iteration, emit })
  }

  const report = {
    status: 'ok',
    findings: 'QA skipped because manager requested a holding/no-op task.',
    specsRun: [], testsPassed: 0, testsFailed: 0,
    verification: [], blockers: [], confidence: 'high',
  }
  emit('agent:qa', { phase: 'done', report })
  return report
}

async function runBackendOrSkip({ instruction, iteration, emit }) {
  if (!isHoldingTask(instruction)) {
    return runBackendAgent({
      task: instruction,
      iteration,
      emit,
    })
  }

  const report = {
    status: 'ok',
    findings: 'Backend skipped because manager requested a holding/no-op task.',
    executedPath: [],
    payloadObserved: null,
    blockers: [],
    confidence: 'high',
  }
  emit('agent:backend', { phase: 'done', report })
  return report
}

async function runLoop(runId, requirement) {
  const historyFile = createRunHistory(runId, requirement)
  const emit = makeEmit(runId, historyFile)

  emit('run:start', { requirement, maxIterations: CONFIG.maxIterations, historyFile })

  emit('run:state', { state: 'memory_lookup' })
  const memory = findReusableRunMemory(requirement)

  let roadmap
  if (memory) {
    roadmap = memory.roadmap
    emit('run:memory-hit', {
      sourceRunId: memory.runId,
      matchedBy: memory.matchedBy,
      approved: Boolean(memory.approval?.approved),
      finalVerdict: memory.final?.verdict ?? null,
      roadmap,
    })
    if (memory.final?.verdict === 'pass') {
      emit('run:prior-pass-rerun', {
        sourceRunId: memory.runId,
        summary: memory.final.summary,
        message: 'Prior run passed — this rerun will verify only, not re-implement.',
      })
    }
  } else {
    emit('run:memory-miss', {})
    emit('run:state', { state: 'planning' })
    roadmap = await runPlanningAgent({ requirement, emit })
  }
  recordRoadmap(historyFile, roadmap)

  if (roadmap.status === 'needs_clarification') {
    const final = {
      verdict: 'blocked',
      summary: `Planning needs clarification: ${(roadmap.clarifyingQuestions ?? []).join(' ') || 'No questions provided.'}`,
      iterations: 0,
    }
    recordFinal(historyFile, final)
    emit('run:done', final)
    return
  }

  let approval
  if (memory?.approval?.approved) {
    approval = {
      approved: true,
      reviewer: 'memory',
      notes: `Reused approval from ${memory.runId}`,
    }
  } else {
    emit('run:state', { state: 'awaiting_approval' })
    approval = await waitForApproval(runId, roadmap, emit)
  }
  recordApproval(historyFile, approval)

  if (!approval.approved) {
    const final = {
      verdict: 'blocked',
      summary: `Roadmap rejected before implementation.${approval.reason ? ` Reason: ${approval.reason}` : ''}`,
      iterations: 0,
    }
    recordFinal(historyFile, final)
    emit('run:rejected', { reason: approval.reason ?? '' })
    emit('run:done', final)
    return
  }

  emit('run:approved', { roadmap })
  const priorPass = memory?.final?.verdict === 'pass' ? memory : null
  emit('run:state', { state: priorPass ? 'verifying' : 'implementing' })

  let backendReport  = null
  let frontendReport = null
  let qaReport       = null
  let finalDecision  = null

  for (let i = 0; i < CONFIG.maxIterations; i++) {
    recordIterationStart(historyFile, i)
    emit('iteration:start', { iteration: i })

    // QA env blocked + frontend ok → don't burn another iteration re-dispatching the same check
    if (i > 0 && isQaEnvironmentBlocked(qaReport) && frontendReport?.status === 'ok') {
      const final = {
        verdict:    'blocked',
        summary:    buildManualQaSummary({ qaReport, frontendReport, priorPass }),
        iterations: i,
      }
      recordFinal(historyFile, final)
      emit('run:qa-env-blocked', { qaReport, autoConcluded: true })
      emit('run:done', final)
      return
    }

    // ── manager decides ──────────────────────────────────────────────────────
    const historySummary = summarizeHistory(historyFile)
    let decision = await runManagerAgent({
      requirement,
      roadmap,
      iteration: i,
      backendReport,
      frontendReport,
      qaReport,
      historySummary,
      priorPass,
      emit,
    })

    finalDecision = decision
    recordManagerDecision(historyFile, i, decision)

    if (decision.action === 'done') {
      if (decision.verdict === 'pass') {
        const qaRanCypress = (qaReport?.specsRun?.length ?? 0) > 0
          || (qaReport?.verification ?? []).some(v => /run_cypress|cypress run/i.test(v))
        const qaEnvBlocked = isQaEnvironmentBlocked(qaReport)
        if (!qaReport) {
          emit('run:qa-missing', { message: 'Pass verdict issued but QA agent never ran.' })
        } else if (qaEnvBlocked) {
          emit('run:qa-env-blocked', { message: 'Pass verdict issued but QA was blocked by Cypress environment — use manual QA or fix Cypress cache.' })
          decision = {
            ...decision,
            verdict: 'blocked',
            summary: `${decision.summary} QA blocked (Cypress env): manual staging validation required.`,
          }
        } else if (!qaRanCypress && isHoldingTask(qaReport.findings ?? '')) {
          emit('run:qa-missing', { message: 'Pass verdict issued but QA only ran standby — no Cypress executed.' })
        }
      }
      const final = {
        verdict:    decision.verdict,
        summary:    decision.summary,
        iterations: i,
      }
      recordFinal(historyFile, final)
      emit('run:done', final)
      return
    }

    // ── sub-agents run in parallel ───────────────────────────────────────────
    const dispatch = normalizeDispatchDecision(decision, { roadmap, iteration: i, frontendReport, priorPass, emit })

    emit('iteration:dispatch', {
      iteration: i,
      backendInstruction:  dispatch.backendInstruction,
      frontendInstruction: dispatch.frontendInstruction,
      qaInstruction:       dispatch.qaInstruction,
    })

    ;[backendReport, frontendReport, qaReport] = await Promise.all([
      runBackendOrSkip({
        instruction: dispatch.backendInstruction,
        iteration: i,
        emit,
      }),
      runFrontendAgent({
        task:      dispatch.frontendInstruction,
        iteration: i,
        emit,
      }),
      runQaOrSkip({
        instruction: dispatch.qaInstruction,
        iteration: i,
        emit,
      }),
    ])

    emit('iteration:done', { iteration: i, backendReport, frontendReport, qaReport })
    recordIterationReports(historyFile, i, backendReport, frontendReport, qaReport)
  }

  // hit max iterations
  const final = {
    verdict:  'blocked',
    summary:  `Reached max iterations (${CONFIG.maxIterations}). Last manager reasoning: ${finalDecision?.reasoning ?? 'unknown'}`,
    iterations: CONFIG.maxIterations,
  }
  recordFinal(historyFile, final)
  emit('run:done', final)
}

// ─── Express server ───────────────────────────────────────────────────────────

const app = express()
app.use(cors())
app.use(express.json())

// SSE stream endpoint — dashboard connects here
app.get('/stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection',    'keep-alive')
  res.flushHeaders()
  req.socket.setKeepAlive(true)
  clients.add(res)
  req.on('close', () => clients.delete(res))
})

// start a run
app.post('/run', async (req, res) => {
  const { requirement } = req.body
  if (!requirement?.trim()) return res.status(400).json({ error: 'requirement is required' })

  const runId = `run-${Date.now()}`
  res.json({ runId, status: 'started' })

  // run asynchronously so the HTTP response returns immediately
  runLoop(runId, requirement.trim()).catch(err => {
    console.error('Loop error:', err)
    broadcast('run:error', { runId, error: err.message })
  })
})

app.post('/approve/:runId', (req, res) => {
  const pending = pendingApprovals.get(req.params.runId)
  if (!pending) return res.status(404).json({ error: 'no pending approval for run' })

  pendingApprovals.delete(req.params.runId)
  pending.resolve({
    approved: true,
    reviewer: req.body?.reviewer ?? 'manual',
    notes:    req.body?.notes ?? '',
  })
  res.json({ ok: true, status: 'approved' })
})

app.post('/reject/:runId', (req, res) => {
  const pending = pendingApprovals.get(req.params.runId)
  if (!pending) return res.status(404).json({ error: 'no pending approval for run' })

  pendingApprovals.delete(req.params.runId)
  pending.resolve({
    approved: false,
    reviewer: req.body?.reviewer ?? 'manual',
    reason:   req.body?.reason ?? '',
  })
  res.json({ ok: true, status: 'rejected' })
})

// health check
app.get('/health', (_, res) => res.json({ ok: true, clients: clients.size }))

// dashboard config
app.get('/config', (_, res) => res.json({
  frontendUrl: `http://localhost:${CONFIG.ports.frontend}`,
  backendUrl:  `http://localhost:${CONFIG.ports.backend}`,
  maxIterations: CONFIG.maxIterations,
}))

// serve the dashboard UI
app.use(express.static(path.join(__dirname, 'dashboard')))

app.listen(CONFIG.ports.runner, () => {
  console.log(`\n Agent runner listening on http://localhost:${CONFIG.ports.runner}`)
  console.log(` Dashboard UI at        http://localhost:${CONFIG.ports.runner}/`)
  console.log(` SSE stream at          http://localhost:${CONFIG.ports.runner}/stream`)
  console.log(` POST /run to start a loop\n`)
})
