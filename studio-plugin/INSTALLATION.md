# Studio Plugin Installation

The Roblox Studio MCP plugin is the bridge between your AI assistant and Studio. It polls the local MCP server for work and executes Studio API calls on behalf of your AI.

---

## Installation

### Method 1: GitHub Release (Recommended)

1. Download [`MCPPlugin.rbxmx`](https://github.com/aaronaalmendarez/roblox-mcp/releases/latest/download/MCPPlugin.rbxmx) from the latest release
2. Save to your plugins folder:

   | OS          | Path                             |
   | ----------- | -------------------------------- |
   | **Windows** | `%LOCALAPPDATA%\Roblox\Plugins\` |
   | **macOS**   | `~/Documents/Roblox/Plugins/`    |

   > Or in Studio: **Plugins tab** → **Plugins Folder** → drop the file in

3. **Restart Roblox Studio** — plugin appears in your toolbar

### Method 2: Build From Source

```bash
npm run build:plugin
```

Then copy `studio-plugin/MCPPlugin.rbxmx` to your plugins folder and restart Studio.

### Method 3: Save as Local Plugin

1. Open [`studio-plugin/MCPPlugin.rbxmx`](https://github.com/aaronaalmendarez/roblox-mcp/blob/main/studio-plugin/MCPPlugin.rbxmx) on GitHub
2. Copy the entire file contents
3. In Studio → create a new **Script** in **ServerScriptService**
4. Paste the code
5. **Right-click** the script → **Save as Local Plugin…**
6. Name it `Roblox Studio MCP`

Plugin appears immediately — no restart needed.

---

## Setup

### 1. Enable HTTP Requests (Required)

**Game Settings** → **Security** → ✅ **Allow HTTP Requests**

> This must be enabled for every place you want to use with MCP.

### 2. Activate the Plugin

Click the **MCP Server** button in the Plugins toolbar:

| Status      | Meaning                                                 |
| ----------- | ------------------------------------------------------- |
| 🟢 **Green** | Connected — server is running and responding            |
| 🔴 **Red**   | Disconnected — normal when MCP server isn't running yet |

### 3. Connect Your AI

Set up your MCP client to launch the server. Quick options:

**Claude Code:**
```bash
claude mcp add robloxstudio -- npx -y @aaronalm19/roblox-mcp@latest
```

**Gemini CLI:**
```bash
gemini mcp add robloxstudio npx --trust -- -y @aaronalm19/roblox-mcp@latest
```

**Generic JSON config:**
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

> Full client configurations: [docs/CLIENTS.md](../docs/CLIENTS.md)

<details>
<summary>Windows: <code>npx</code> not found?</summary>

Wrap with `cmd`:
```json
{
  "command": "cmd",
  "args": ["/c", "npx", "-y", "@aaronalm19/roblox-mcp@latest"]
}
```
</details>

---

## How It Works

```
AI calls tool → MCP server queues request → Plugin polls (500ms) → Plugin executes → AI receives result
```

1. Your AI invokes an MCP tool (e.g. `get_script_source`)
2. The MCP server queues the request on `localhost:3002`
3. The Studio plugin polls for pending work every 500ms
4. The plugin executes the corresponding Studio API call
5. Results flow back through the bridge to your AI

**37+ tools** cover instance trees, scripts, properties, attributes, tags, object creation, and diagnostics.

---

## Plugin Features

| Feature            | Details                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------- |
| **Visual status**  | Toolbar indicator shows connection state in real-time                                       |
| **Smart polling**  | Exponential backoff on failed connections to reduce overhead                                |
| **Error recovery** | Automatic retry with 30-second request timeouts                                             |
| **Debug logging**  | Comprehensive output in Studio's Output window                                              |
| **Configurable**   | Server URL (default `http://localhost:3002`) and poll interval (default 500ms) are editable |

### Enable Debug Mode

```lua
-- In plugin source code:
local DEBUG_MODE = true
```

---

## Troubleshooting

| Problem                | Fix                                                                    |
| ---------------------- | ---------------------------------------------------------------------- |
| **Plugin missing**     | Verify `.rbxmx` is in the correct plugins folder → restart Studio      |
| **HTTP 403**           | Enable **Allow HTTP Requests** in Game Settings → Security             |
| **Shows disconnected** | Start the MCP server — red status is normal until then                 |
| **Connection refused** | Check Windows Firewall isn't blocking `localhost:3002`                 |
| **Old plugin version** | Rebuild (`npm run build:plugin`), recopy, and **fully restart Studio** |
| **Errors in Output**   | Check Studio's Output window for detailed error messages               |

---

## Security

- **Local-only** — plugin only communicates with `localhost:3002`
- **No external servers** — nothing leaves your machine
- **Explicit actions** — tools run only when your MCP client invokes them
- **No data collection** — your projects remain completely private
