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

## How it works

Every day at **8 AM**, Jira Autopilot:

| Step | What happens |
|------|-------------|
| 1 | Fetches open tickets from Jira via JQL |
| 2 | Planning agent reads the ticket and writes a fix roadmap |
| 3 | Backend + frontend agents work in parallel on a fresh clone of your repo |
| 4 | QA agent runs Cypress E2E verification |
| 5 | On pass — commits to a `fix/<TICKET>` branch and opens a GitHub PR |
| 6 | Posts PR link + summary as a Jira comment |

> **Demo**
> 
> <!-- Record with: npx terminalizer record demo && npx terminalizer render demo -->
> <!-- Replace the line below with: ![Demo](./assets/demo.gif) -->
> ```
> $ npm run daily
> Jira Autopilot — 2025-01-09T08:00:00.000Z
> JQL: project = "ENG" AND status in ("To Do","Open")
> Found 3 ticket(s)
> 
> ── ENG-142: Fix PIN verify redirect loop
>   cloning org/backend…
>   cloning org/frontend…
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

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     Daily Runner  (8 AM)                      │
│                   scripts/daily-runner.js                     │
└────────────────────────┬─────────────────────────────────────┘
                         │  per ticket: clone → run → PR → comment
                         ▼
┌──────────────────────────────────────────────────────────────┐
│                       Orchestrator                            │
│         Planner → [Manager → Backend + Frontend + QA]  loop  │
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

Sub-agents never talk to each other. All coordination goes through the manager.

</details>

<details>
<summary><b>Agent roles</b></summary>

| Agent | Role | Tools |
|-------|------|-------|
| **Planner** | Reads Jira ticket, writes fix roadmap | Jira MCP |
| **Manager** | Decomposes roadmap, reviews reports, re-tasks on gaps | record_manager_decision |
| **Backend** | Reads/writes backend code, runs commands, hits HTTP endpoints | read_file, write_file, run_command, http_request |
| **Frontend** | Reads/writes frontend code, intercepts API calls via Playwright | read_file, write_file, intercept_api_call, monitor_websocket |
| **QA** | Runs Cypress E2E tests, verifies the full flow | run_cypress, check_dev_server |

</details>

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

**Server / CI** — set these and repos are cloned fresh per ticket. Nothing to pre-install:

```env
GITHUB_TOKEN=ghp_...
GITHUB_BACKEND_REPO=org/your-backend
GITHUB_FRONTEND_REPO=org/your-frontend
```

**Local dev only** — if those vars are absent, edit `config.js` instead:

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
npm run daily:dry   # lists tickets, runs no agents
```

### 5. Run once

```bash
npm run daily
```

### 6. Schedule at 8 AM

```bash
npm run daily:schedule   # writes launchd plist on macOS, loads it immediately
```

Logs go to `~/Library/Logs/jira-autopilot/`.

```bash
# To unschedule:
launchctl unload ~/Library/LaunchAgents/com.jira-autopilot.daily.plist
rm ~/Library/LaunchAgents/com.jira-autopilot.daily.plist
```

---

## Dashboard (interactive mode)

For live runs with human approval and streaming logs:

```bash
npm start
# open http://localhost:4000
```

> **Dashboard preview**
>
> <!-- Record with LICEcap or Kap, save to assets/dashboard.gif -->
> <!-- Replace the line below with: ![Dashboard](./assets/dashboard.gif) -->
> *Type a requirement or Jira key (e.g. `ENG-123`) → hit Run → watch agents stream live.*

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
│   ├── anthropicClient.js    ← Anthropic SDK wrapper + prompt cache helper
│   ├── planner.js            ← roadmap creation + Jira ticket fetch
│   ├── manager.js            ← task decomposition + cross-referencing
│   ├── backend.js            ← backend sub-agent
│   ├── frontend.js           ← frontend sub-agent (Playwright)
│   ├── qa.js                 ← QA + Cypress orchestration
│   ├── jiraMcp.js            ← Jira read (MCP) + write (REST)
│   └── playbook.js           ← lessons-learned injected into prompts
├── tools/
│   └── index.js              ← 30+ tools (file, shell, HTTP, browser)
├── dashboard/
│   └── index.html            ← live React UI (SSE-powered)
└── runs/                     ← JSON history per run
```

---

## Token usage

<details>
<summary><b>Cost breakdown per ticket</b></summary>

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
| Prompt caching (`cache_control: ephemeral`) on all 5 agents | ✅ |
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
agentMaxTokens:   3200,      // backend output
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
- [`gh` CLI](https://cli.github.com/) authenticated (`gh auth login`)
- Playwright Chromium (`npx playwright install chromium`)
- GitHub token with `repo` + `workflow` scopes (for server cloning)

---

<div align="center">

Built with [Claude](https://anthropic.com) · [Report an issue](https://github.com/dev2842000/jira-autopilot/issues)

</div>
