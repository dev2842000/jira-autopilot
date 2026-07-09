# Agent runner

Multi-agent orchestrator that takes any engineering requirement, dispatches it to a backend and frontend sub-agent, and loops until the full flow is verified end-to-end — no manual intervention.

## Structure

```
agent-runner/
├── orchestrator.js      ← loop engine + Express server (port 4000)
├── config.js            ← your repo paths and ports — EDIT THIS FIRST
├── agents/
│   ├── manager.js       ← manager agent (fixed system prompt)
│   ├── backend.js       ← backend sub-agent (fixed role + tools)
│   └── frontend.js      ← frontend sub-agent (fixed role + tools)
├── tools/
│   └── index.js         ← tool implementations (read_file, run_cmd, ws, playwright)
└── dashboard/
    └── index.html       ← live visualiser UI (served at localhost:4000)
```

## Setup

### 1. Place next to your repos
```
your-project/
├── frontend/
├── backend/
├── admin/
└── agent-runner/   ← here
```

### 2. Edit config.js
Open `config.js` and set the correct relative paths and ports for your repos:
```js
paths: {
  backend:  '../backend',
  frontend: '../frontend',
  admin:    '../admin',
},
ports: {
  backend:  3000,
  frontend: 5173,
  ...
}
```

### 3. Install dependencies
```bash
cd agent-runner
npm install
```

### 4. Install Playwright browser (for frontend interception)
```bash
npx playwright install chromium
```

### 5. Set your Anthropic API key
```bash
export ANTHROPIC_API_KEY=sk-ant-...
# or add to a .env file and use dotenv
```

### 6. Start your existing services
Make sure your backend (port 3000) and frontend (port 5173) are already running.

### 7. Run the agent runner
```bash
npm start
# or for auto-reload during dev:
npm run dev
```

### 8. Open the dashboard
```
http://localhost:4000
```

Type a requirement and hit Run. Watch the three panels fill up in real time.

## How it works

1. You type a requirement into the dashboard
2. Manager agent decomposes it into backend + frontend tasks
3. Both sub-agents run in parallel — each has a fixed role, tools, and output schema
4. Sub-agents use tools (read_file, run_command, http_request, monitor_websocket, intercept_api_call) to do real work against your actual running code
5. Both report back to manager with structured JSON
6. Manager cross-references reports, identifies gaps, re-tasks if needed
7. Loop repeats until manager says "done" or max iterations hit
8. Dashboard shows live logs, iteration progress, and final verdict

## Agent roles (never change)

**Manager** — decomposes requirements, reads reports, re-tasks or closes loop. Never touches code.

**Backend agent** — reads backend source files, runs commands, hits HTTP endpoints, traces execution paths.

**Frontend agent** — reads frontend source files, monitors WebSocket/SSE channels, uses Playwright to intercept API calls in a real browser.

## Notes

- Agents do NOT modify source files — read and execute only
- The `intercept_api_call` tool launches a real headless Chromium — requires Playwright installed
- The `monitor_websocket` tool requires the `ws` package (included in dependencies)
- Max 5 iterations by default — change in `config.js`
- All agent communication goes through the manager — sub-agents never talk directly to each other
