#!/usr/bin/env node

/**
 * MCP HTTP Bridge
 *
 * Aggregates multiple MCP servers behind an HTTP gateway into a single
 * stdio MCP interface. Designed for Claude Desktop and other MCP clients
 * that connect via stdio but need to reach servers behind an HTTP proxy.
 *
 * Environment variables:
 *   MCP_GATEWAY_URL   - Base URL of the HTTP gateway (default: http://localhost:9090)
 *   MCP_SERVERS       - Comma-separated list of server names to aggregate
 *   MCP_CLIENT_NAME   - Client identifier sent via X-Client-Name header (default: claude-desktop)
 *   MCP_AUTH_TOKEN    - Optional bearer token for authenticated gateways
 *   MCP_ENDPOINT_PATTERN - URL pattern for tool calls (default: /mcp/{server}/tools/call)
 *
 * @see https://github.com/OmegaTeee/mcp-http-bridge
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// --- Configuration ---

const GATEWAY_URL = (process.env.MCP_GATEWAY_URL || 'http://localhost:9090').replace(/\/+$/, '');
const CLIENT_NAME = process.env.MCP_CLIENT_NAME || 'claude-desktop';
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || '';
const ENDPOINT_PATTERN = process.env.MCP_ENDPOINT_PATTERN || '/mcp/{server}/tools/call';

const SERVERS = (process.env.MCP_SERVERS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (SERVERS.length === 0) {
  console.error('Error: MCP_SERVERS is required (comma-separated list of server names)');
  console.error('Example: MCP_SERVERS=context7,memory,search node index.js');
  process.exit(1);
}

// --- HTTP Gateway Communication ---

/**
 * Build the endpoint URL for a server, replacing {server} in the pattern.
 */
function buildUrl(serverName) {
  const path = ENDPOINT_PATTERN.replace('{server}', serverName);
  return `${GATEWAY_URL}${path}`;
}

/**
 * Send a JSON-RPC request to a server through the HTTP gateway.
 */
async function callGateway(serverName, jsonRpcRequest) {
  const url = buildUrl(serverName);

  const headers = {
    'Content-Type': 'application/json',
    'X-Client-Name': CLIENT_NAME,
  };

  if (AUTH_TOKEN) {
    headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(jsonRpcRequest),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json();

  // Handle REST-style error responses (e.g., FastAPI { detail: "..." })
  if (data.detail) {
    return {
      jsonrpc: '2.0',
      error: { code: -32001, message: data.detail },
      id: jsonRpcRequest.id,
    };
  }

  return data;
}

// --- Tool Aggregation ---

/**
 * Fetch and namespace tools from all configured servers.
 *
 * Each tool is prefixed with its server name to avoid conflicts:
 *   "read_file" on server "filesystem" becomes "filesystem_read_file"
 */
async function getAllTools() {
  const allTools = [];

  for (const serverName of SERVERS) {
    try {
      const response = await callGateway(serverName, {
        jsonrpc: '2.0',
        method: 'tools/list',
        id: 1,
      });

      if (response.result?.tools) {
        const prefixedTools = response.result.tools.map(tool => ({
          ...tool,
          name: `${serverName}_${tool.name}`,
          description: `[${serverName}] ${tool.description}`,
        }));
        allTools.push(...prefixedTools);
      }
    } catch (error) {
      console.error(`[${serverName}] Failed to fetch tools: ${error.message}`);
    }
  }

  return allTools;
}

/**
 * Route a tool call to the correct server by parsing the namespace prefix.
 *
 * Tool name format: "{server}_{tool}" — split on first underscore only.
 */
async function callTool(toolName, args) {
  const separatorIndex = toolName.indexOf('_');
  if (separatorIndex === -1) {
    throw new Error(`Invalid tool name format: ${toolName} (expected: server_toolname)`);
  }

  const serverName = toolName.slice(0, separatorIndex);
  const actualToolName = toolName.slice(separatorIndex + 1);

  if (!SERVERS.includes(serverName)) {
    throw new Error(`Unknown server: ${serverName}. Available: ${SERVERS.join(', ')}`);
  }

  const response = await callGateway(serverName, {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: actualToolName, arguments: args },
    id: 1,
  });

  if (response.error) {
    throw new Error(response.error.message);
  }

  return response.result;
}

// --- MCP Server ---

async function main() {
  const server = new Server(
    { name: 'mcp-http-bridge', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await getAllTools();
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await callTool(name, args || {});
      return {
        content: [{
          type: 'text',
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`mcp-http-bridge started`);
  console.error(`  Gateway: ${GATEWAY_URL}`);
  console.error(`  Servers: ${SERVERS.join(', ')}`);
  console.error(`  Client:  ${CLIENT_NAME}`);
  if (AUTH_TOKEN) console.error(`  Auth:    Bearer token set`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
