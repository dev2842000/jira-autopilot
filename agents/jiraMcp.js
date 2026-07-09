import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CONFIG } from '../config.js'

const ISSUE_KEY_RE = /\b[A-Z][A-Z0-9]+-\d+\b/

function pickTicketKey(input = '') {
  return input.match(ISSUE_KEY_RE)?.[0] ?? null
}

function pickTool(tools = [], configuredName = '') {
  if (configuredName) {
    return tools.find(tool => tool.name === configuredName) ?? { name: configuredName }
  }

  return tools.find(tool => /jira/i.test(tool.name) && /(issue|ticket|get|fetch|read)/i.test(tool.name))
    ?? tools.find(tool => /(get|fetch|read).*(issue|ticket)/i.test(tool.name))
    ?? tools.find(tool => /(issue|ticket)/i.test(tool.name))
}

function pickIssueKeyArgument(tool, configuredArgument = '') {
  if (configuredArgument) return configuredArgument

  const properties = tool?.inputSchema?.properties ?? {}
  const required = tool?.inputSchema?.required ?? []
  const candidates = ['issueKey', 'issue_key', 'ticketKey', 'ticket_key', 'key', 'id']

  return candidates.find(candidate => Object.hasOwn(properties, candidate))
    ?? required[0]
    ?? 'issueKey'
}

function normalizeToolResult(result) {
  const textParts = Array.isArray(result?.content)
    ? result.content.flatMap(part => {
      if (part.type === 'text') return [part.text]
      if (part.type === 'resource' && part.resource?.text) return [part.resource.text]
      if (part.type === 'resource_link') return [`${part.name}: ${part.uri}`]
      return []
    })
    : []

  return {
    structuredContent: result?.structuredContent ?? null,
    text: textParts.join('\n').trim(),
    isError: Boolean(result?.isError),
  }
}

function jiraRestHeaders() {
  const creds = Buffer.from(`${process.env.JIRA_USER_EMAIL}:${process.env.JIRA_API_KEY}`).toString('base64')
  return {
    'Authorization': `Basic ${creds}`,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
  }
}

export async function listJiraTickets(jql) {
  const base = process.env.JIRA_INSTANCE_URL
  if (!base) throw new Error('JIRA_INSTANCE_URL is not set')
  const url = `${base}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=20&fields=summary,description,status,assignee`
  const res = await fetch(url, { headers: jiraRestHeaders() })
  if (!res.ok) throw new Error(`Jira list failed: ${res.status} ${await res.text()}`)
  const data = await res.json()
  return data.issues ?? []
}

export async function commentOnJiraTicket(ticketKey, text) {
  const base = process.env.JIRA_INSTANCE_URL
  if (!base) throw new Error('JIRA_INSTANCE_URL is not set')
  const url = `${base}/rest/api/3/issue/${ticketKey}/comment`
  const res = await fetch(url, {
    method:  'POST',
    headers: jiraRestHeaders(),
    body: JSON.stringify({
      body: {
        type: 'doc', version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
      },
    }),
  })
  if (!res.ok) throw new Error(`Jira comment failed: ${res.status} ${await res.text()}`)
  return res.json()
}

export function findJiraTicketKey(requirement) {
  return pickTicketKey(requirement)
}

export async function fetchJiraTicket({ ticketKey }) {
  const mcp = CONFIG.jira?.mcp
  if (!mcp?.enabled || !mcp.command) {
    return {
      ok: false,
      ticketKey,
      error: 'Jira MCP is not configured. Set JIRA_MCP_COMMAND and JIRA_MCP_ARGS_JSON.',
    }
  }

  const transport = new StdioClientTransport({
    command: mcp.command,
    args:    mcp.args ?? [],
    env:     process.env,
    stderr:  'pipe',
  })
  const stderrChunks = []
  transport.stderr?.on('data', chunk => {
    stderrChunks.push(chunk.toString())
  })

  const client = new Client({
    name:    'agent-runner-planner',
    version: '1.0.0',
  })

  try {
    await client.connect(transport, { timeout: CONFIG.jira?.mcpTimeoutMs ?? 20_000 })
    const listed = await client.listTools({}, { timeout: CONFIG.jira?.mcpTimeoutMs ?? 20_000 })
    const tool = pickTool(listed.tools, mcp.toolName)

    if (!tool?.name) {
      return {
        ok: false,
        ticketKey,
        error: 'Connected to Jira MCP, but no issue/ticket fetch tool was found.',
        availableTools: listed.tools?.map(item => item.name) ?? [],
        stderr: stderrChunks.join('').trim() || undefined,
      }
    }

    const argumentName = pickIssueKeyArgument(tool, mcp.issueKeyArgument)
    const result = await client.callTool({
      name: tool.name,
      arguments: {
        [argumentName]: ticketKey,
      },
    }, undefined, { timeout: CONFIG.jira?.mcpTimeoutMs ?? 20_000 })

    return {
      ok: !result?.isError,
      ticketKey,
      toolName: tool.name,
      argumentName,
      result: normalizeToolResult(result),
      stderr: stderrChunks.join('').trim() || undefined,
    }
  } catch (error) {
    return {
      ok: false,
      ticketKey,
      error: error.message,
      stderr: stderrChunks.join('').trim() || undefined,
      command: mcp.command,
      args: mcp.args ?? [],
    }
  } finally {
    await transport.close().catch(() => {})
  }
}
