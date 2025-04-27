![Supergateway: Run stdio MCP servers over SSE, WS, and HTTP Stream](https://raw.githubusercontent.com/supercorp-ai/supergateway/main/supergateway.png)

**Supergateway** runs **MCP stdio-based servers** over **SSE (Server-Sent Events)**, **WebSockets (WS)**, or **HTTP Stream** with one command. This is useful for remote access, debugging, or connecting to clients when your MCP server only supports stdio.

Supported by [Supermachine](https://supermachine.ai) (hosted MCPs), [Superinterface](https://superinterface.ai), and [Supercorp](https://supercorp.ai).

## Installation & Usage

Run Supergateway via `npx`:

```bash
npx -y supergateway --stdio "uvx mcp-server-git"
```

- **`--stdio "command"`**: Command that runs an MCP server over stdio
- **`--sse "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app"`**: SSE URL to connect to (SSE→stdio mode)
- **`--outputTransport stdio | sse | ws | http-stream`**: Output MCP transport (default: `sse` with `--stdio`, `stdio` with `--sse`)
- **`--port 8000`**: Port to listen on (stdio→SSE, stdio→WS, or stdio→HTTP mode, default: `8000`)
- **`--baseUrl "http://localhost:8000"`**: Base URL for SSE or WS clients (stdio→SSE mode; optional)
- **`--ssePath "/sse"`**: Path for SSE subscriptions (stdio→SSE mode, default: `/sse`)
- **`--messagePath "/message"`**: Path for messages (stdio→SSE or stdio→WS mode, default: `/message`)
- **`--endpoint "/mcp"`**: HTTP Stream endpoint path (stdio→HTTP mode, default: `/mcp`)
- **`--responseMode batch | stream`**: HTTP Stream response mode (stdio→HTTP mode, default: `batch`)
- **`--batchTimeout 30000`**: Timeout for batch responses in ms (stdio→HTTP mode, default: `30000`)
- **`--sessionHeaderName "Mcp-Session-Id"`**: Session header name (stdio→HTTP mode, default: `Mcp-Session-Id`)
- **`--header "x-user-id: 123"`**: Add one or more headers (stdio→SSE, stdio→HTTP, or SSE→stdio mode; can be used multiple times)
- **`--oauth2Bearer "some-access-token"`**: Adds an `Authorization` header with the provided Bearer token
- **`--logLevel info | none`**: Controls logging level (default: `info`). Use `none` to suppress all logs.
- **`--cors`**: Enable CORS (stdio→SSE, stdio→WS, or stdio→HTTP mode). Use `--cors` with no values to allow all origins, or supply one or more allowed origins (e.g. `--cors "http://example.com"` or `--cors "/example\\.com$/"` for regex matching).
- **`--healthEndpoint /healthz`**: Register one or more endpoints (stdio→SSE, stdio→WS, or stdio→HTTP mode; can be used multiple times) that respond with `"ok"`

## stdio → SSE

Expose an MCP stdio server as an SSE server:

```bash
npx -y supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem ./my-folder" \
    --port 8000 --baseUrl http://localhost:8000 \
    --ssePath /sse --messagePath /message
```

- **Subscribe to events**: `GET http://localhost:8000/sse`
- **Send messages**: `POST http://localhost:8000/message`

## SSE → stdio

Connect to a remote SSE server and expose locally via stdio:

```bash
npx -y supergateway --sse "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app"
```

Useful for integrating remote SSE MCP servers into local command-line environments.

You can also pass headers when sending requests. This is useful for authentication:

```bash
npx -y supergateway \
    --sse "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app" \
    --oauth2Bearer "some-access-token" \
    --header "X-My-Header: another-header-value"
```

## stdio → WS

Expose an MCP stdio server as a WebSocket server:

```bash
npx -y supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem ./my-folder" \
    --port 8000 --outputTransport ws --messagePath /message
```

- **WebSocket endpoint**: `ws://localhost:8000/message`

## stdio → HTTP Stream

Expose an MCP stdio server as an HTTP Stream server (recommended for modern web clients):

```bash
npx -y supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem ./my-folder" \
    --port 8000 --outputTransport http-stream --endpoint /mcp
```

- **HTTP Stream endpoint**: `http://localhost:8000/mcp`

### HTTP Stream modes

The HTTP Stream transport supports two response modes:

**Batch mode** (default):

```bash
npx -y supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem ./my-folder" \
    --outputTransport http-stream --responseMode batch
```

**Stream mode** (for progressive responses):

```bash
npx -y supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem ./my-folder" \
    --outputTransport http-stream --responseMode stream
```

### HTTP Stream session management

HTTP Stream provides built-in session management with the `Mcp-Session-Id` header:

```bash
npx -y supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem ./my-folder" \
    --outputTransport http-stream --sessionHeaderName "Custom-Session-Header"
```

## Example with MCP Inspector (stdio → SSE mode)

1. **Run Supergateway**:

```bash
npx -y supergateway --port 8000 \
    --stdio "npx -y @modelcontextprotocol/server-filesystem /Users/MyName/Desktop"
```

2. **Use MCP Inspector**:

```bash
npx @modelcontextprotocol/inspector
```

You can now list tools, resources, or perform MCP actions via Supergateway.

## Using with ngrok

Use [ngrok](https://ngrok.com/) to share your local MCP server publicly:

```bash
npx -y supergateway --port 8000 --stdio "npx -y @modelcontextprotocol/server-filesystem ."

# In another terminal:
ngrok http 8000
```

ngrok provides a public URL for remote access.

MCP server will be available at URL similar to: https://1234-567-890-12-456.ngrok-free.app/sse

## Running with Docker

A Docker-based workflow avoids local Node.js setup. A ready-to-run Docker image is available here:
[supercorp/supergateway](https://hub.docker.com/r/supercorp/supergateway). Also on GHCR: [ghcr.io/supercorp-ai/supergateway](https://github.com/supercorp-ai/supergateway/pkgs/container/supergateway)

### Using the Official Image

```bash
docker run -it --rm -p 8000:8000 supercorp/supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem /" \
    --port 8000
```

Docker pulls the image automatically. The MCP server runs in the container’s root directory (`/`). You can mount host directories if needed.

### Building the Image Yourself

Use provided Dockerfile:

```bash
docker build -t supergateway .

docker run -it --rm -p 8000:8000 supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem /" \
    --port 8000
```

## Using with Claude Desktop (SSE → stdio mode)

Claude Desktop can use Supergateway’s SSE→stdio mode.

### NPX-based MCP Server Example

```json
{
  "mcpServers": {
    "supermachineExampleNpx": {
      "command": "npx",
      "args": [
        "-y",
        "supergateway",
        "--sse",
        "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app"
      ]
    }
  }
}
```

### Docker-based MCP Server Example

```json
{
  "mcpServers": {
    "supermachineExampleDocker": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "supercorp/supergateway",
        "--sse",
        "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app"
      ]
    }
  }
}
```

## Using with Cursor (SSE → stdio mode)

Cursor can also integrate with Supergateway in SSE→stdio mode. The configuration is similar to Claude Desktop.

### NPX-based MCP Server Example for Cursor

```json
{
  "mcpServers": {
    "cursorExampleNpx": {
      "command": "npx",
      "args": [
        "-y",
        "supergateway",
        "--sse",
        "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app"
      ]
    }
  }
}
```

### Docker-based MCP Server Example for Cursor

```json
{
  "mcpServers": {
    "cursorExampleDocker": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "supercorp/supergateway",
        "--sse",
        "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app"
      ]
    }
  }
}
```

**Note:** Although the setup supports sending headers via the `--header` flag, if you need to pass an Authorization header (which typically includes a space, e.g. `"Bearer 123"`), you must use the `--oauth2Bearer` flag due to a known Cursor bug with spaces in command-line arguments.

## Why MCP?

[Model Context Protocol](https://spec.modelcontextprotocol.io/) standardizes AI tool interactions. Supergateway converts MCP stdio servers into SSE, WS, or HTTP Stream services, simplifying integration and debugging with web-based or remote clients. The HTTP Stream transport is the recommended modern approach for web-based MCP applications.

## Advanced Configuration

Supergateway emphasizes modularity:

- Automatically manages JSON-RPC versioning.
- Retransmits package metadata where possible.
- stdio→SSE, stdio→WS, or stdio→HTTP mode logs via standard output; SSE→stdio mode logs via stderr.
- HTTP Stream mode supports session management and both batch and streaming responses.

## Additional resources

- [Superargs](https://github.com/supercorp-ai/superargs) - provide arguments to MCP servers during runtime.

## Contributors

- [@StefanBurscher](https://github.com/StefanBurscher)
- [@tarasyarema](https://github.com/tarasyarema)
- [@pcnfernando](https://github.com/pcnfernando)
- [@Areo-Joe](https://github.com/Areo-Joe)
- [@Joffref](https://github.com/Joffref)
- [@michaeljguarino](https://github.com/michaeljguarino)

## Contributing

Issues and PRs welcome. Please open one if you encounter problems or have feature suggestions.

## License

[MIT License](./LICENSE)
