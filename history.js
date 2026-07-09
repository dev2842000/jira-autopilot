import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { CONFIG } from './config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RUNS_DIR = path.join(__dirname, 'runs')
const MAX_HISTORY_TEXT_CHARS = CONFIG.maxHistoryTextChars ?? 1200
const ISSUE_KEY_RE = /\b[A-Z][A-Z0-9]+-\d+\b/

function compact(value, maxChars = MAX_HISTORY_TEXT_CHARS) {
  if (typeof value === 'string') {
    if (value.length <= maxChars) return value
    return `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`
  }
  if (Array.isArray(value)) return value.map(item => compact(item, maxChars))
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, compact(entry, maxChars)])
  )
}

function readHistory(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function writeHistory(filePath, history) {
  fs.writeFileSync(filePath, `${JSON.stringify(history, null, 2)}\n`)
}

function normalizeRequirement(requirement = '') {
  return requirement.trim().toLowerCase()
}

function ticketKeyFrom(value = '') {
  return String(value).match(ISSUE_KEY_RE)?.[0] ?? null
}

function ensureIteration(history, iteration) {
  let entry = history.iterations.find(item => item.iteration === iteration)
  if (!entry) {
    entry = {
      iteration,
      managerDecision: null,
      backendReport:   null,
      frontendReport:  null,
      qaReport:        null,
      events:          [],
    }
    history.iterations.push(entry)
  }
  return entry
}

export function createRunHistory(runId, requirement) {
  fs.mkdirSync(RUNS_DIR, { recursive: true })
  const filePath = path.join(RUNS_DIR, `${runId}.json`)
  writeHistory(filePath, {
    runId,
    requirement,
    startedAt:  new Date().toISOString(),
    roadmap:    null,
    approval:   null,
    events:     [],
    iterations: [],
    final:      null,
  })
  return filePath
}

export function appendRunEvent(filePath, event, data = {}) {
  const history = readHistory(filePath)
  const entry = { ts: Date.now(), event, data: compact(data) }
  history.events.push(entry)

  if (typeof data.iteration === 'number') {
    ensureIteration(history, data.iteration).events.push(entry)
  }

  writeHistory(filePath, history)
}

export function recordIterationStart(filePath, iteration) {
  const history = readHistory(filePath)
  ensureIteration(history, iteration)
  writeHistory(filePath, history)
}

export function recordManagerDecision(filePath, iteration, decision) {
  const history = readHistory(filePath)
  ensureIteration(history, iteration).managerDecision = compact(decision)
  writeHistory(filePath, history)
}

export function recordRoadmap(filePath, roadmap) {
  const history = readHistory(filePath)
  history.roadmap = compact(roadmap)
  writeHistory(filePath, history)
}

export function recordApproval(filePath, approval) {
  const history = readHistory(filePath)
  history.approval = compact({ ...approval, decidedAt: new Date().toISOString() })
  writeHistory(filePath, history)
}

export function recordIterationReports(filePath, iteration, backendReport, frontendReport, qaReport = null) {
  const history = readHistory(filePath)
  const entry = ensureIteration(history, iteration)
  entry.backendReport = compact(backendReport)
  entry.frontendReport = compact(frontendReport)
  entry.qaReport = compact(qaReport)
  writeHistory(filePath, history)
}

export function recordFinal(filePath, final) {
  const history = readHistory(filePath)
  history.final = compact({ ...final, finishedAt: new Date().toISOString() })
  writeHistory(filePath, history)
}

export function findReusableRunMemory(requirement) {
  if (!fs.existsSync(RUNS_DIR)) return null

  const requestedTicket = ticketKeyFrom(requirement)
  const normalizedRequirement = normalizeRequirement(requirement)

  const candidates = fs.readdirSync(RUNS_DIR)
    .filter(name => name.endsWith('.json'))
    .map(name => {
      const filePath = path.join(RUNS_DIR, name)
      try {
        const history = readHistory(filePath)
        const roadmap = history.roadmap
        if (roadmap?.status !== 'ready') return null

        const roadmapTicket = roadmap.source?.ticketKey ?? ticketKeyFrom(history.requirement)
        const sameTicket = requestedTicket && roadmapTicket === requestedTicket
        const sameRequirement = normalizeRequirement(history.requirement) === normalizedRequirement

        if (!sameTicket && !sameRequirement) return null

        return {
          runId: history.runId,
          requirement: history.requirement,
          roadmap,
          approval: history.approval,
          final: history.final,
          matchedBy: sameTicket ? 'jira-ticket' : 'requirement',
          startedAt: history.startedAt,
          mtimeMs: fs.statSync(filePath).mtimeMs,
        }
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => {
      const aPass = a.final?.verdict === 'pass' ? 1 : 0
      const bPass = b.final?.verdict === 'pass' ? 1 : 0
      if (bPass !== aPass) return bPass - aPass
      return b.mtimeMs - a.mtimeMs
    })

  return candidates[0] ?? null
}

export function summarizeHistory(filePath) {
  const history = readHistory(filePath)
  if (!history.iterations.length) return 'No previous iterations.'

  return history.iterations.map(entry => {
    const parts = [`Iteration ${entry.iteration + 1}:`]
    if (entry.managerDecision) {
      parts.push(`manager=${entry.managerDecision.action}${entry.managerDecision.reasoning ? ` (${entry.managerDecision.reasoning})` : ''}`)
    }
    if (entry.backendReport) {
      parts.push(`backend=${entry.backendReport.status}: ${entry.backendReport.findings ?? 'no findings'}`)
    }
    if (entry.frontendReport) {
      parts.push(`frontend=${entry.frontendReport.status}: ${entry.frontendReport.findings ?? 'no findings'}`)
    }
    if (entry.qaReport) {
      parts.push(`qa=${entry.qaReport.status}: ${entry.qaReport.findings ?? 'no findings'}`)
    }
    return `- ${parts.join(' ')}`
  }).join('\n')
}
