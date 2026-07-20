# Connecting Clients to the Local MCP

The local MCP is served by a single long-lived **daemon** that owns the graph
replica (see `local-mcp-boundary.md`). Clients never open the replica directly;
they connect to the daemon in one of two ways.

## Mode 1 — stdio proxy (default, universal)

Point the client at the launcher script. It runs a thin proxy that connects to
the daemon over a `0600` Unix domain socket (spawning/kickstarting the daemon if
needed). Works in every MCP client, no token in client config — the socket is
filesystem-permissioned to the current user.

```jsonc
// Claude Code .mcp.json / Claude Desktop claude_desktop_config.json
{
  "mcpServers": {
    "living-atlas-local": {
      "command": "/path/to/deploy/scripts/run-local-mcp.sh"
    }
  }
}
```

```toml
# Codex ~/.codex/config.toml
[mcp_servers.living-atlas-local]
command = "/path/to/deploy/scripts/run-local-mcp.sh"
```

## Mode 2 — loopback HTTP URL (remote-like)

The daemon can also expose the MCP over **Streamable HTTP** — the same transport
remote MCP servers use — bound to `127.0.0.1` only. Clients that accept a URL
connect directly, no proxy process. Enabled by
`LIVING_ATLAS_LOCAL_MCP_HTTP_PORT` on the daemon.

- **Loopback only.** Bound to `127.0.0.1`; nothing off the machine can reach it.
  The listener refuses to bind a routable interface.
- **Token required on every request.** A loopback TCP port is reachable by any
  local process (unlike the socket), so `Authorization: Bearer <token>` is
  mandatory and checked in constant time. A tokenless listener fails closed.
- **DNS-rebinding protected.** Requests whose `Host` header isn't the loopback
  binding are rejected, blocking malicious-webpage attacks on the local port.

```jsonc
// Claude Code .mcp.json (HTTP transport)
{
  "mcpServers": {
    "living-atlas-local": {
      "type": "http",
      "url": "http://127.0.0.1:<port>/mcp",
      "headers": { "Authorization": "Bearer <local-mcp-token>" }
    }
  }
}
```

Trade-off: Mode 2 is the most "remote-like" and drops the proxy, but it opens a
listening loopback port and requires the token to live in client config. Mode 1
keeps the token in the Keychain and the surface as a `0600` socket. Both hit the
same daemon and the same store.
