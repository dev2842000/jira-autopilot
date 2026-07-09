#!/usr/bin/env node
/**
 * Daily runner — fetches open Jira tickets, runs the agent loop on each,
 * raises a GitHub PR for any code changes, and comments the result on Jira.
 *
 * Usage:
 *   node scripts/daily-runner.js            # run now
 *   node scripts/daily-runner.js --dry-run  # list tickets only, no agents
 *   node scripts/daily-runner.js --install-cron  # schedule 8 AM via launchd
 */

import { execSync }  from 'child_process'
import path          from 'path'
import os            from 'os'
import fs            from 'fs'
import { fileURLToPath } from 'url'
import { CONFIG }    from '../config.js'
import { listJiraTickets, commentOnJiraTicket } from '../agents/jiraMcp.js'
import { runLoop }   from '../orchestrator.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DRY_RUN   = process.argv.includes('--dry-run')

// ─── JQL ─────────────────────────────────────────────────────────────────────

function buildJql() {
  if (CONFIG.jira.jql) return CONFIG.jira.jql
  if (!CONFIG.jira.projectKey) throw new Error('Set JIRA_PROJECT_KEY or JIRA_JQL in .env')
  return `project = "${CONFIG.jira.projectKey}" AND status in ("To Do","Open","In Progress") AND assignee is not EMPTY ORDER BY priority DESC`
}

// ─── git helpers (operates on backend or frontend repo) ───────────────────────

function hasUncommittedChanges(repoPath) {
  try {
    return execSync('git status --porcelain', { cwd: repoPath, encoding: 'utf8' }).trim().length > 0
  } catch { return false }
}

function createPr(repoPath, ticketKey, summary) {
  const branch = `fix/${ticketKey.toLowerCase()}`
  const title  = `fix(${ticketKey}): ${summary.slice(0, 60)}`
  const body   = `## Summary\n\n${summary}\n\n🤖 Raised automatically by [Jira Autopilot](https://github.com/dev2842000/jira-autopilot)`

  try {
    // branch may already exist on retry — reset to origin/main if so
    try {
      execSync(`git checkout -b ${branch}`, { cwd: repoPath, stdio: 'pipe' })
    } catch {
      execSync(`git checkout ${branch}`, { cwd: repoPath, stdio: 'pipe' })
    }
    execSync('git add -A', { cwd: repoPath })
    execSync(`git commit -m ${JSON.stringify(`fix(${ticketKey}): ${summary.slice(0, 72)}`)}`, { cwd: repoPath })
    execSync(`git push -u origin ${branch}`, { cwd: repoPath, stdio: 'pipe' })
    const url = execSync(
      `gh pr create --title ${JSON.stringify(title)} --body ${JSON.stringify(body)} --head ${branch}`,
      { cwd: repoPath, encoding: 'utf8' }
    ).trim()
    return url
  } catch (err) {
    console.error(`  PR failed for ${repoPath}:`, err.message)
    return null
  }
}

// ─── per-ticket flow ──────────────────────────────────────────────────────────

async function processTicket(ticket) {
  const key   = ticket.key
  const title = ticket.fields.summary ?? ''
  const desc  = ticket.fields.description ?? ''
  const requirement = `${key}: ${title}\n\n${typeof desc === 'string' ? desc : JSON.stringify(desc)}`

  console.log(`\n── ${key}: ${title}`)

  if (DRY_RUN) {
    console.log('  [dry-run] skipping agent loop')
    return
  }

  const runId = `autopilot-${key}-${Date.now()}`
  let result
  try {
    result = await runLoop(runId, requirement, { autoApprove: true })
  } catch (err) {
    console.error(`  Loop error for ${key}:`, err.message)
    await commentOnJiraTicket(key, `Jira Autopilot: agent loop crashed — ${err.message}`).catch(() => {})
    return
  }

  console.log(`  verdict: ${result?.verdict}`)

  // raise PRs if agents changed files
  const prUrls = []
  if (result?.verdict === 'pass') {
    for (const [label, repoPath] of [['backend', CONFIG.paths.backend], ['frontend', CONFIG.paths.frontend]]) {
      if (repoPath && hasUncommittedChanges(repoPath)) {
        console.log(`  creating PR in ${label}…`)
        const url = createPr(repoPath, key, result.summary)
        if (url) { prUrls.push(`${label}: ${url}`); console.log(`  PR: ${url}`) }
      }
    }
  }

  // comment on Jira
  const comment = result?.verdict === 'pass'
    ? [
        `✅ Jira Autopilot: fix verified (${result.iterations ?? 0} iteration(s)).`,
        '',
        result.summary,
        '',
        prUrls.length ? `PRs raised:\n${prUrls.join('\n')}` : 'No code changes committed.',
      ].join('\n')
    : `⚠️ Jira Autopilot: ${result?.verdict ?? 'error'} — ${result?.summary ?? 'unknown error'}`

  await commentOnJiraTicket(key, comment).catch(err => console.error(`  Jira comment failed:`, err.message))
}

// ─── launchd installer (macOS, 8 AM daily) ───────────────────────────────────

function installCron() {
  const label     = 'com.jira-autopilot.daily'
  const plistPath = path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`)
  const script    = path.resolve(__dirname, 'daily-runner.js')
  const logDir    = path.join(os.homedir(), 'Library/Logs/jira-autopilot')
  fs.mkdirSync(logDir, { recursive: true })

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>             <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${script}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>   <integer>8</integer>
    <key>Minute</key> <integer>0</integer>
  </dict>
  <key>WorkingDirectory</key>  <string>${path.resolve(__dirname, '..')}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key> <string>${process.env.PATH}</string>
  </dict>
  <key>StandardOutPath</key>   <string>${logDir}/stdout.log</string>
  <key>StandardErrorPath</key> <string>${logDir}/stderr.log</string>
  <key>RunAtLoad</key>         <false/>
</dict>
</plist>`

  fs.writeFileSync(plistPath, plist)
  execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`, { shell: true })
  execSync(`launchctl load "${plistPath}"`)
  console.log(`Scheduled daily at 8 AM. Logs: ${logDir}/stdout.log`)
  console.log(`To remove: launchctl unload "${plistPath}" && rm "${plistPath}"`)
}

// ─── main ─────────────────────────────────────────────────────────────────────

if (process.argv.includes('--install-cron')) {
  installCron()
  process.exit(0)
}

console.log(`Jira Autopilot — ${new Date().toISOString()}${DRY_RUN ? ' [DRY RUN]' : ''}`)
const jql = buildJql()
console.log(`JQL: ${jql}`)

const tickets = await listJiraTickets(jql)
console.log(`Found ${tickets.length} ticket(s)`)

for (const ticket of tickets) {
  await processTicket(ticket)
}

console.log('\nDone.')
