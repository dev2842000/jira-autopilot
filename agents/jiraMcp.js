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
