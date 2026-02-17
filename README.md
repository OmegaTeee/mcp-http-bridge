# mcp-http-bridge

Aggregate multiple MCP servers behind an HTTP gateway into a single stdio MCP interface.

```
Claude Desktop ──stdio──▶ mcp-http-bridge ──HTTP──▶ Your Gateway ──▶ MCP Servers
```

MCP clients like Claude Desktop connect via stdio, but your servers may sit behind an HTTP gateway (FastAPI, Express, nginx, etc.). This bridge translates between the two — collecting tools from all your servers and routing calls through HTTP.

## Quick Start

```bash
npx mcp-http-bridge
```

Or install globally:

```bash
npm install -g mcp-http-bridge
```

## Configuration

All configuration is via environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MCP_SERVERS` | Yes | — | Comma-separated server names (e.g., `filesystem,memory,search`) |
| `MCP_GATEWAY_URL` | No | `http://localhost:9090` | Base URL of your HTTP gateway |
| `MCP_CLIENT_NAME` | No | `claude-desktop` | Sent as `X-Client-Name` header |
| `MCP_AUTH_TOKEN` | No | — | Bearer token for authenticated gateways |
| `MCP_ENDPOINT_PATTERN` | No | `/mcp/{server}/tools/call` | URL pattern (`{server}` is replaced) |

## How It Works

1. On startup, the bridge calls `tools/list` on each server via the gateway
2. Tools are namespaced to avoid conflicts: `filesystem_read_file`, `memory_store`, etc.
3. When Claude calls a tool, the bridge parses the prefix and routes to the correct server
4. Responses flow back through stdio to the client

### Tool Namespacing

Each tool is prefixed with its server name:

| Server | Original Tool | Bridged Name |
|--------|---------------|--------------|
| filesystem | `read_file` | `filesystem_read_file` |
| memory | `store` | `memory_store` |
| search | `query` | `search_query` |

## Claude Desktop Configuration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "my-servers": {
      "command": "npx",
      "args": ["-y", "mcp-http-bridge"],
      "env": {
        "MCP_GATEWAY_URL": "http://localhost:9090",
        "MCP_SERVERS": "filesystem,memory,search"
      }
    }
  }
}
```

### With Authentication

```json
{
  "mcpServers": {
    "my-servers": {
      "command": "npx",
      "args": ["-y", "mcp-http-bridge"],
      "env": {
        "MCP_GATEWAY_URL": "https://my-gateway.example.com",
        "MCP_SERVERS": "filesystem,memory,search",
        "MCP_AUTH_TOKEN": "your-bearer-token"
      }
    }
  }
}
```

### Custom Endpoint Pattern

If your gateway uses a different URL structure:

```json
{
  "env": {
    "MCP_GATEWAY_URL": "http://localhost:8080",
    "MCP_SERVERS": "fs,db",
    "MCP_ENDPOINT_PATTERN": "/api/v1/{server}/rpc"
  }
}
```

## Gateway Requirements

Your HTTP gateway must accept JSON-RPC POST requests at the configured endpoint pattern and support two methods:

### `tools/list`

```json
// Request
{ "jsonrpc": "2.0", "method": "tools/list", "id": 1 }

// Response
{
  "jsonrpc": "2.0",
  "result": {
    "tools": [
      {
        "name": "read_file",
        "description": "Read a file from disk",
        "inputSchema": { "type": "object", "properties": { "path": { "type": "string" } } }
      }
    ]
  },
  "id": 1
}
```

### `tools/call`

```json
// Request
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": { "name": "read_file", "arguments": { "path": "/tmp/test.txt" } },
  "id": 1
}

// Response
{
  "jsonrpc": "2.0",
  "result": { "content": [{ "type": "text", "text": "file contents here" }] },
  "id": 1
}
```

## License

MIT
