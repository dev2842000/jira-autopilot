import dotenv from 'dotenv'

dotenv.config({ path: '.env', quiet: true })
dotenv.config({ path: '.env.local', override: true, quiet: true })

function parseJSONEnvArray(value) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function parseModelList(value) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed.filter(Boolean)
  } catch {}
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

// ─── edit these to match your local setup ────────────────────────────────────
export const CONFIG = {
  // absolute paths to each repo folder
  paths: {
    backend:  '/Users/devkumar/Documents/GitHub/lunar',
    frontend: '/Users/devkumar/Documents/GitHub/crobo-web',
    admin:    '../admin',
  },

  // ports each service runs on locally
  ports: {
    backend:       3001,
    frontend:      3000,
    adminBackend:  3002,
    adminFrontend: 5174,
    runner:        4000,   // orchestrator API + SSE stream
    dashboard:     4001,   // visualiser UI
  },

  // Anthropic model. Override with ANTHROPIC_MODEL for deeper investigations.
  model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5-20250929',
  modelFallbacks: parseModelList(process.env.ANTHROPIC_MODEL_FALLBACKS).length
    ? parseModelList(process.env.ANTHROPIC_MODEL_FALLBACKS)
    : [
      'claude-sonnet-4-5-20250929',
      'claude-sonnet-4-20250514',
      'claude-3-7-sonnet-20250219',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-sonnet-20240620',
    ],

  // Optional Jira MCP server for the planning agent.
  // Example:
  // JIRA_MCP_COMMAND=npx
  // JIRA_MCP_ARGS_JSON='["-y","your-jira-mcp-server"]'
  jira: {
    mcp: {
      enabled: process.env.JIRA_MCP_ENABLED === 'true' || Boolean(process.env.JIRA_MCP_COMMAND),
      command: process.env.JIRA_MCP_COMMAND ?? '',
      args:    parseJSONEnvArray(process.env.JIRA_MCP_ARGS_JSON),
      toolName: process.env.JIRA_MCP_TOOL ?? '',
      issueKeyArgument: process.env.JIRA_MCP_ISSUE_KEY_ARGUMENT ?? '',
    },
    mcpTimeoutMs: Number(process.env.JIRA_MCP_TIMEOUT_MS ?? 20_000),
  },

  // cost controls
  plannerMaxTokens: 4096,
  managerMaxTokens: 1200,
  agentMaxTokens:   3200,
  frontendMaxTokens: 5000,
  maxAgentToolTurns: 10,
  maxFrontendToolTurns: 24,
  qaMaxTokens: 4000,
  maxQaToolTurns: 12,
  maxToolTextChars:  8000,
  maxHistoryTextChars: 1200,

  cypress: {
    cacheFolder: process.env.CYPRESS_CACHE_FOLDER ?? '/tmp/cypress-cache',
    defaultTimeoutMs: Number(process.env.CYPRESS_TIMEOUT_MS ?? 180_000),
    browser: process.env.CYPRESS_BROWSER ?? 'electron',
  },

  // max loop iterations before giving up
  maxIterations: 3,

  // ms to wait for each agent before timing out
  agentTimeoutMs: 60_000,
}
