# Jira Autopilot

> Picks up your Jira tickets every morning, fixes the code, raises a PR, and comments the summary — no human in the loop.

```
Jira ticket → AI agents fix code → GitHub PR → Jira comment
```

---

## What it does

Every day at 8 AM, Jira Autopilot:

1. **Fetches open Jira tickets** via JQL query
2. **Plans a fix** — a planning agent reads the ticket and writes a roadmap
3. **Executes the fix** — backend + frontend agents work in parallel on your actual codebase
4. **Verifies** — QA agent runs end-to-end checks until passing or max iterations hit
5. **Raises a PR** — commits changes to a branch, opens a GitHub pull request
6. **Comments on Jira** — posts PR link + fix summary back to the ticket

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Daily Runner (8 AM)                │
│                  scripts/daily-runner.js             │
└──────────────────────┬──────────────────────────────┘
                       │ per ticket
                       ▼
┌─────────────────────────────────────────────────────┐
│                    Orchestrator                      │
│  Planner → [Manager → Backend + Frontend + QA] loop │
└──────────────────────┬──────────────────────────────┘
                       │
           ┌───────────┼───────────┐
           ▼           ▼           ▼
       GitHub PR   Jira Comment  run history
```

### Agents

| Agent | Role |
|---|---|
| **Planner** | Reads Jira ticket, writes fix roadmap |
| **Manager** | Decomposes roadmap into tasks, reviews reports, re-tasks on gaps |
| **Backend** | Reads/writes backend code, runs commands, hits HTTP endpoints |
| **Frontend** | Reads/writes frontend code, intercepts API calls via Playwright |
| **QA** | Runs Cypress E2E tests, verifies the full flow |

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/dev2842000/jira-autopilot.git
cd jira-autopilot
npm install
npx playwright install chromium
```

### 2. Configure your repos

**Server / CI** — set these env vars and the runner clones repos fresh per ticket. No pre-installed repos needed:

```env
GITHUB_TOKEN=ghp_...
GITHUB_BACKEND_REPO=org/your-backend
GITHUB_FRONTEND_REPO=org/your-frontend
```

**Local dev only** — if those vars are absent, the runner falls back to paths in `config.js`:

```js
paths: {
  backend:  '/absolute/path/to/your/backend',
  frontend: '/absolute/path/to/your/frontend',
},
ports: { backend: 3001, frontend: 3000 }
```

### 3. Set environment variables

```bash
cp .env.example .env
```

Fill in `.env`:

```env
# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Jira — instance URL + API token from https://id.atlassian.com/manage-profile/security/api-tokens
JIRA_INSTANCE_URL=https://yourcompany.atlassian.net
JIRA_USER_EMAIL=you@yourcompany.com
JIRA_API_KEY=your-jira-api-token

# Which project to pull tickets from each morning
JIRA_PROJECT_KEY=ENG

# Optional: override the default JQL entirely
# JIRA_JQL=project = "ENG" AND status = "To Do" AND labels = "autopilot"

# Jira MCP (used by the planning agent to fetch individual tickets)
JIRA_MCP_COMMAND=npx
JIRA_MCP_ARGS_JSON=["-y","jira-mcp"]
JIRA_MCP_TOOL=get_issue
JIRA_MCP_ISSUE_KEY_ARGUMENT=issueIdOrKey

# GitHub — repos cloned fresh per ticket; generate at https://github.com/settings/tokens (repo + workflow scopes)
GITHUB_TOKEN=ghp_...
GITHUB_BACKEND_REPO=org/your-backend
GITHUB_FRONTEND_REPO=org/your-frontend
```

### 4. Dry-run to verify Jira connection

Lists tickets from your project without running any agents:

```bash
npm run daily:dry
```

### 5. Run once manually

```bash
npm run daily
```

### 6. Schedule at 8 AM (macOS)

```bash
npm run daily:schedule
```

Writes a `launchd` plist to `~/Library/LaunchAgents/` and loads it immediately. Logs land in `~/Library/Logs/jira-autopilot/`.

To unschedule:
```bash
launchctl unload ~/Library/LaunchAgents/com.jira-autopilot.daily.plist
rm ~/Library/LaunchAgents/com.jira-autopilot.daily.plist
```

---

## Manual / Dashboard mode

For interactive runs with live logs and human approval:

```bash
npm start
# open http://localhost:4000
```

Type a requirement or Jira ticket key (e.g. `ENG-123`) and hit **Run**.

---

## Project structure

```
jira-autopilot/
├── scripts/
│   └── daily-runner.js      ← entry point for scheduled runs
├── orchestrator.js           ← agent loop engine + Express/SSE server
├── config.js                 ← repo paths, ports, model, limits
├── history.js                ← run persistence + duplicate detection
├── agents/
│   ├── anthropicClient.js    ← Anthropic SDK wrapper with model fallback
│   ├── planner.js            ← roadmap creation + Jira ticket fetch
│   ├── manager.js            ← task decomposition + cross-referencing
│   ├── backend.js            ← backend sub-agent
│   ├── frontend.js           ← frontend sub-agent
│   ├── qa.js                 ← QA + Cypress orchestration
│   ├── jiraMcp.js            ← Jira MCP client (read + write)
│   └── playbook.js           ← lessons learned injected into prompts
├── tools/
│   └── index.js              ← 30+ tools (file, shell, HTTP, browser, git)
├── dashboard/
│   └── index.html            ← live React UI (SSE-powered)
└── runs/                     ← JSON history per run
```

---

## Requirements

- Node.js 18+
- [Anthropic API key](https://console.anthropic.com/)
- [Jira API token](https://id.atlassian.com/manage-profile/security/api-tokens)
- [`gh` CLI](https://cli.github.com/) authenticated (`gh auth login`)
- Playwright Chromium (`npx playwright install chromium`)
- Your backend + frontend services running (for agent verification)

---

## How agents communicate

```
Planner ──roadmap──▶ Manager
                        │
               ┌────────┼────────┐
               ▼        ▼        ▼
           Backend  Frontend    QA
               │        │        │
               └────────┴────────┘
                        │ structured JSON reports
                        ▼
                     Manager
                (cross-reference, re-task or close)
```

Sub-agents never talk to each other. All coordination goes through the manager.

---

## Token usage

Each full run (one Jira ticket, one iteration) uses approximately:

| Agent | Input tokens | Output tokens | Notes |
|---|---|---|---|
| Planner | ~1,500 | ~800 | One-shot, no tool loop |
| Manager | ~2,000–4,000 | ~300 | Forced tool call output; re-called each iteration |
| Backend | ~3,000–8,000 | ~1,500 | Tool loop up to 10 turns; input grows each turn |
| Frontend | ~3,000–10,000 | ~2,000 | Tool loop up to 24 turns + Playwright |
| QA | ~2,000–5,000 | ~800 | Tool loop up to 12 turns |

**Typical single-ticket run: ~15,000–30,000 input tokens, ~5,000–8,000 output tokens.**

At Sonnet pricing (~$3/M input, $15/M output) that's roughly **$0.12–$0.25 per ticket**.

### Optimisation status

| Optimisation | Status |
|---|---|
| Tool result truncation (8,000 chars) | ✅ |
| History summary truncation (1,200 chars) | ✅ |
| Prompt caching (`cache_control: ephemeral`) | ✅ all 5 agents |
| Compact JSON in manager messages | ✅ roadmap + 3 reports compacted |
| Model tiering (Haiku for simple tasks) | ❌ all agents use Sonnet |

Without prompt caching, the system prompt (~400–800 tokens per agent) is re-sent on **every tool loop turn**. Enabling `cache_control: { type: "ephemeral" }` on system prompts cuts re-sent system prompt costs by ~90% after the first call.

## Config reference

```js
// config.js
model: 'claude-sonnet-4-5-20250929',
maxIterations: 3,          // re-task loops before giving up
agentTimeoutMs: 60_000,    // per-agent wall time
managerMaxTokens: 1200,    // output only — manager uses forced tool call
agentMaxTokens:   3200,    // backend output
frontendMaxTokens: 5000,
qaMaxTokens:      4000,
maxAgentToolTurns:    10,
maxFrontendToolTurns: 24,
maxQaToolTurns:       12,
maxToolTextChars:  8000,   // tool result truncation
maxHistoryTextChars: 1200, // history summary truncation
```
