<div align="center">

# 🤖 Jira Autopilot

**Picks up your Jira tickets every morning, fixes the code, raises a PR, and comments the summary — no human in the loop.**

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Claude](https://img.shields.io/badge/Powered%20by-Claude%20Sonnet-D97706?logo=anthropic&logoColor=white)](https://anthropic.com)
[![License](https://img.shields.io/badge/license-MIT-3B82F6)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/dev2842000/jira-autopilot?style=social)](https://github.com/dev2842000/jira-autopilot/stargazers)

```
Jira ticket → AI agents fix code → GitHub PR → Jira comment
```

</div>

---

## What it does

Every day at **8 AM**, Jira Autopilot:

| Step | What happens |
|------|-------------|
| 1 | Fetches open tickets from Jira via JQL |
| 2 | Planning agent reads the ticket and writes a fix roadmap |
| 3 | Backend + frontend agents work in parallel on a **fresh clone** of your repo |
| 4 | QA agent runs Cypress E2E verification |
| 5 | On pass — commits to a `fix/<TICKET>` branch and opens a GitHub PR |
| 6 | Posts PR link + summary as a Jira comment |

> <!-- Record with: npx terminalizer record demo && npx terminalizer render demo -->
> <!-- Replace with: ![Demo](./assets/demo.gif) -->
> ```
> $ npm run daily
> Jira Autopilot — 2025-01-09T08:00:00.000Z
> JQL: project = "ENG" AND status in ("To Do","Open")
> Found 3 ticket(s)
>
> ── ENG-142: Fix PIN verify redirect loop
>   cloning org/backend…  cloning org/frontend…
>   verdict: pass
>   PR: https://github.com/org/frontend/pull/87
>
> ── ENG-143: Profile API returns 500 on missing field
>   cloning org/backend…
>   verdict: pass
>   PR: https://github.com/org/backend/pull/34
> Done.
> ```

---

## Why fixes are reliable

Most AI coding tools generate a diff and hope for the best. Jira Autopilot has four layers that make fixes trustworthy.

### 1. Ponytail coding discipline

Backend and frontend agents follow the **ponytail ladder** before writing a single line:

```
1. Does this change need to exist at all?
   → If it's a config or data issue, stop. No code needed.

2. Already in this codebase?
   → Search for an existing util or pattern before writing one.

3. Stdlib / built-in does it?
   → Native platform feature before a library.

4. Already-installed dependency solves it?
   → Use it. Never add a package for 5 lines.

5. Can it be one line?  →  One line.

6. Only then: the minimum code that works.
```

**Bug fix = root cause, not symptom.** Before editing any function, agents grep every caller. The lazy fix is one guard in the shared path — smaller diff, and it fixes all callers at once, not just the one the ticket names.

Deliberate shortcuts are marked: `// ponytail: linear scan, add index if table exceeds 10k rows` — so the next engineer knows it's intentional, not ignorance.

### 2. Manager verification loop

Agents don't self-report pass. A separate **manager agent** cross-references every sub-agent report against the original roadmap and acceptance criteria. If backend says fixed but QA says broken — the manager re-tasks, not closes.

```
Iteration 1: Backend fixes route guard. QA: dev server down → blocked.
Iteration 2: Manager re-tasks QA with "confirm server running first".
             QA: server up, Cypress passes. Manager: verdict pass.
```

Max 3 iterations before it gives up and reports `blocked` — it never loops forever burning tokens.

### 3. Playbook — lessons from past runs

Every post-mortem gets encoded as a rule injected into agent system prompts:

| Lesson | Rule |
|--------|------|
| React Router blank page | Never redirect a parent route to the path you're already on — child `<Outlet>` won't render |
| Over-simplified redirect fix | Removing a guard for `/pin` (verify) must not remove the guard for `/pin/set` (setup) |
| False pass on syntax only | `node -c` passing ≠ routing works at runtime. Cypress must load the destination page. |
| Cypress sudo trap | One attempt max. Never retry in a loop when the environment isn't ready. |

Agents can't repeat known mistakes. Each production incident makes the next run smarter.

### 4. Fresh clone per run

Every ticket gets a `git clone --depth 1` into a temp directory. Agents work there, commit to a `fix/<TICKET>` branch, and the temp dir is deleted after. No shared state between tickets, no drift from previous runs.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     Daily Runner  (8 AM)                      │
│                   scripts/daily-runner.js                     │
└────────────────────────┬─────────────────────────────────────┘
                         │  per ticket
                         │  git clone → run loop → PR → Jira comment → cleanup
                         ▼
┌──────────────────────────────────────────────────────────────┐
│                        Orchestrator                           │
│          Planner → [Manager → Backend + Frontend + QA] loop  │
└────────────────────────┬─────────────────────────────────────┘
                         │
             ┌───────────┼───────────┐
             ▼           ▼           ▼
         GitHub PR  Jira Comment  runs/ history
```

<details>
<summary><b>Agent communication flow</b></summary>

```
Planner ──roadmap──▶ Manager
                        │
               ┌────────┼────────┐
               ▼        ▼        ▼
           Backend  Frontend    QA
               │        │        │
               └────────┴────────┘
                        │  structured JSON reports
                        ▼
                     Manager
                (cross-reference → re-task or close)
```

Sub-agents never talk to each other. All coordination goes through the manager. Each agent outputs a structured JSON report — status, changedFiles, findings, blockers, confidence. The manager reads all three before deciding the next action.

</details>

<details>
<summary><b>Agent roles</b></summary>

| Agent | Role | Tools |
|-------|------|-------|
| **Planner** | Reads Jira ticket via MCP, writes a fix roadmap with acceptance criteria | Jira MCP |
| **Manager** | Decomposes roadmap into tasks, cross-references reports, re-tasks on gaps | record_manager_decision |
| **Backend** | Reads/writes backend code, runs commands, hits HTTP endpoints | read_file, write_file, run_command, http_request, search_code |
| **Frontend** | Reads/writes frontend code, intercepts API calls via Playwright | read_file, write_file, intercept_api_call, monitor_websocket |
| **QA** | Runs Cypress E2E tests, verifies acceptance criteria | run_cypress, check_dev_server |

</details>

<details>
<summary><b>Run memory — no duplicate fixes</b></summary>

Every run is persisted to `runs/` as a JSON file. Before planning, the orchestrator checks if a prior run already fixed the same ticket and passed. If yes:

- Skips re-planning and re-implementation
- Runs QA-only re-verification
- Backend and frontend go into standby

This means the same ticket won't get re-fixed and re-PRed every morning.

</details>

---

## What it handles well

- **Routing bugs** — redirect loops, guard conditions, blank pages from wrong `<Outlet>` nesting
- **API bugs** — missing field validation, wrong status codes, unhandled nulls
- **Config fixes** — wrong env var references, missing defaults
- **Small feature additions** — adding a field to an API response, wiring a new route

## Limitations

- **No database migrations** — agents can read schema but won't run `ALTER TABLE` against a production DB
- **No tickets that need product decisions** — if the acceptance criteria is ambiguous, the planner blocks and asks for clarification rather than guessing
- **Cypress-dependent verification** — if your test suite isn't set up, QA reports blocked and the verdict is never `pass`
- **One repo pair** — currently wired to one backend + one frontend repo per run

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/dev2842000/jira-autopilot.git
cd jira-autopilot
npm install
npx playwright install chromium
```

### 2. Configure repos

**Server / CI** — repos are cloned fresh per ticket. Nothing to pre-install:

```env
GITHUB_TOKEN=ghp_...
GITHUB_BACKEND_REPO=org/your-backend
GITHUB_FRONTEND_REPO=org/your-frontend
```

**Local dev only** — if those vars are absent, edit `config.js`:

```js
paths: { backend: '/path/to/backend', frontend: '/path/to/frontend' }
```

### 3. Set environment variables

```bash
cp .env.example .env
```

```env
# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Jira — get token at https://id.atlassian.com/manage-profile/security/api-tokens
JIRA_INSTANCE_URL=https://yourcompany.atlassian.net
JIRA_USER_EMAIL=you@yourcompany.com
JIRA_API_KEY=your-jira-api-token
JIRA_PROJECT_KEY=ENG

# Optional: override the default JQL
# JIRA_JQL=project = "ENG" AND status = "To Do" AND labels = "autopilot"

# Jira MCP (planning agent uses this to fetch individual tickets)
JIRA_MCP_COMMAND=npx
JIRA_MCP_ARGS_JSON=["-y","jira-mcp"]
JIRA_MCP_TOOL=get_issue
JIRA_MCP_ISSUE_KEY_ARGUMENT=issueIdOrKey

# GitHub — repos cloned fresh per ticket
# Generate at https://github.com/settings/tokens (repo + workflow scopes)
GITHUB_TOKEN=ghp_...
GITHUB_BACKEND_REPO=org/your-backend
GITHUB_FRONTEND_REPO=org/your-frontend
```

### 4. Verify Jira connection

```bash
npm run daily:dry   # lists tickets, no agents run
```

### 5. Run once

```bash
npm run daily
```

### 6. Schedule at 8 AM (macOS)

```bash
npm run daily:schedule   # writes launchd plist, loads immediately
```

Logs: `~/Library/Logs/jira-autopilot/`

```bash
# Unschedule:
launchctl unload ~/Library/LaunchAgents/com.jira-autopilot.daily.plist
rm ~/Library/LaunchAgents/com.jira-autopilot.daily.plist
```

---

## Dashboard — interactive mode

For runs with live streaming logs and human approval of the roadmap before agents execute:

```bash
npm start
# open http://localhost:4000
```

> <!-- Record with LICEcap or Kap → save to assets/dashboard.gif -->
> <!-- Replace with: ![Dashboard](./assets/dashboard.gif) -->
> *Type a requirement or Jira key (e.g. `ENG-123`) → approve the roadmap → watch agents stream live.*

---

## Project structure

```
jira-autopilot/
├── scripts/
│   └── daily-runner.js      ← scheduled entry point (clone → loop → PR → comment)
├── orchestrator.js           ← agent loop engine + Express SSE server (port 4000)
├── config.js                 ← paths, ports, model, token limits
├── history.js                ← run persistence + duplicate detection
├── agents/
│   ├── anthropicClient.js    ← Anthropic SDK wrapper + cachedSystem() for prompt caching
│   ├── planner.js            ← roadmap creation + Jira ticket fetch
│   ├── manager.js            ← task decomposition + cross-referencing
│   ├── backend.js            ← backend sub-agent (ponytail ladder)
│   ├── frontend.js           ← frontend sub-agent (ponytail ladder + Playwright)
│   ├── qa.js                 ← QA + Cypress orchestration
│   ├── jiraMcp.js            ← Jira read (MCP) + write (REST API)
│   └── playbook.js           ← lessons-learned injected into agent prompts
├── tools/
│   └── index.js              ← 30+ tools (file, shell, HTTP, browser)
├── dashboard/
│   └── index.html            ← live React UI (SSE-powered)
└── runs/                     ← JSON history per run
```

---

## Token usage

<details>
<summary><b>Cost breakdown per ticket (~$0.12–$0.25)</b></summary>

| Agent | Input tokens | Output tokens | Notes |
|-------|-------------|--------------|-------|
| Planner | ~1,500 | ~800 | One-shot, no tool loop |
| Manager | ~2,000–4,000 | ~300 | Forced tool call; re-called each iteration |
| Backend | ~3,000–8,000 | ~1,500 | Tool loop up to 10 turns |
| Frontend | ~3,000–10,000 | ~2,000 | Tool loop up to 24 turns + Playwright |
| QA | ~2,000–5,000 | ~800 | Tool loop up to 12 turns |

**Typical single-ticket run: ~15,000–30,000 input / ~5,000–8,000 output tokens.**

At Sonnet pricing (~$3/M input, $15/M output) → roughly **$0.12–$0.25 per ticket**.

| Optimisation | Status |
|-------------|--------|
| Tool result truncation (8,000 chars) | ✅ |
| History summary truncation (1,200 chars) | ✅ |
| Prompt caching on all 5 agents | ✅ ~90% reduction on re-sent system prompt tokens |
| Compact JSON in manager messages | ✅ |
| Model tiering (Haiku for simple tasks) | — not implemented |

</details>

---

## Config reference

<details>
<summary><b>All knobs in config.js</b></summary>

```js
model: 'claude-sonnet-4-5-20250929',
maxIterations: 3,            // re-task loops before giving up
agentTimeoutMs: 60_000,      // per-agent wall time (ms)
managerMaxTokens: 1200,      // output only — manager uses forced tool call
agentMaxTokens:   3200,      // backend output tokens
frontendMaxTokens: 5000,
qaMaxTokens:      4000,
maxAgentToolTurns:    10,
maxFrontendToolTurns: 24,
maxQaToolTurns:       12,
maxToolTextChars:  8000,     // tool result truncation
maxHistoryTextChars: 1200,   // history summary truncation
```

</details>

---

## Requirements

- Node.js 18+
- [Anthropic API key](https://console.anthropic.com/)
- [Jira API token](https://id.atlassian.com/manage-profile/security/api-tokens)
- [`gh` CLI](https://cli.github.com/) authenticated
- Playwright Chromium (`npx playwright install chromium`)
- GitHub token with `repo` + `workflow` scopes

---

<div align="center">

Built with [Claude](https://anthropic.com) · [Report an issue](https://github.com/dev2842000/jira-autopilot/issues)

</div>
