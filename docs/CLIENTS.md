# MCP Client Configurations

Roblox Studio MCP uses **stdio transport** and is provider-agnostic — it works with any MCP host that can launch a local command.

## Low-Token Bootstrap

If your client lets you give the agent a startup guide, prefer `AGENT_LITE.md` first and keep `AGENT.md` as the full fallback.

Recommended map-first discovery flow:

1. `get_place_info`
2. `get_structure_map_summary`
3. `query_structure_map`
4. `get_script_inventory` or `get_subsystem_summary`
5. `get_project_structure` only for targeted branches
6. `get_script_source` only when raw code is required

This keeps startup and exploration smaller than starting with wide tree scans or full script reads.

---

## Universal Command

Use this in any client that accepts a command string:

```
npx -y @aaronalm19/roblox-mcp@latest
```

> **Windows note:** If `npx` fails to resolve, prefix with `cmd /c`:
> ```
> cmd /c npx -y @aaronalm19/roblox-mcp@latest
> ```

---

## Claude Code

```bash
claude mcp add robloxstudio -- npx -y @aaronalm19/roblox-mcp@latest
```

## Gemini CLI

```bash
gemini mcp add robloxstudio npx --trust -- -y @aaronalm19/roblox-mcp@latest
```

## Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "robloxstudio-mcp": {
      "command": "npx",
      "args": ["-y", "@aaronalm19/roblox-mcp@latest"]
    }
  }
}
```

<details>
<summary>Windows fallback</summary>

```json
{
  "mcpServers": {
    "robloxstudio-mcp": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@aaronalm19/roblox-mcp@latest"]
    }
  }
}
```
</details>

## Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.robloxstudio]
command = "npx"
args = ["-y", "@aaronalm19/roblox-mcp@latest"]
```

<details>
<summary>Windows fallback</summary>

```toml
[mcp_servers.robloxstudio]
command = "cmd"
args = ["/c", "npx", "-y", "@aaronalm19/roblox-mcp@latest"]
```
</details>

## OpenCode

Add to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "robloxstudio": {
      "type": "local",
      "enabled": true,
      "command": ["npx", "-y", "@aaronalm19/roblox-mcp@latest"]
    }
  }
}
```

<details>
<summary>Windows fallback</summary>

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "robloxstudio": {
      "type": "local",
      "enabled": true,
      "command": ["cmd", "/c", "npx", "-y", "@aaronalm19/roblox-mcp@latest"]
    }
  }
}
```
</details>

## Other mcpServers JSON Clients

Any client that reads a `mcpServers` JSON block (Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "robloxstudio-mcp": {
      "command": "npx",
      "args": ["-y", "@aaronalm19/roblox-mcp@latest"]
    }
  }
}
```

---

## Validation Checklist

After setup, verify everything is connected:

1. ✅ Roblox Studio is open and the plugin is active (green indicator)
2. ✅ **Game Settings → Security → Allow HTTP Requests** is enabled
3. ✅ MCP client shows the server as connected
4. ✅ Calling `get_place_info` returns a valid response

### Quick health check

```bash
curl http://localhost:3002/health
```

Expected: `pluginConnected: true`, `mcpServerActive: true`
