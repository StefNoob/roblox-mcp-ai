import test from "node:test";
import assert from "node:assert/strict";

import { shouldRunMcpInStdioMode } from "./mcp-mode.mjs";

test("uses stdio mode for non-interactive MCP host launches", () => {
	assert.equal(
		shouldRunMcpInStdioMode({
			forceStdio: false,
			forceManaged: false,
			stdinIsTTY: false,
			stdoutIsTTY: false,
		}),
		true,
	);
});

test("stays in managed CLI mode for interactive terminal launches", () => {
	assert.equal(
		shouldRunMcpInStdioMode({
			forceStdio: false,
			forceManaged: false,
			stdinIsTTY: true,
			stdoutIsTTY: true,
		}),
		false,
	);
});

test("honors explicit stdio override", () => {
	assert.equal(
		shouldRunMcpInStdioMode({
			forceStdio: true,
			forceManaged: false,
			stdinIsTTY: true,
			stdoutIsTTY: true,
		}),
		true,
	);
});

test("honors explicit managed override", () => {
	assert.equal(
		shouldRunMcpInStdioMode({
			forceStdio: true,
			forceManaged: true,
			stdinIsTTY: false,
			stdoutIsTTY: false,
		}),
		false,
	);
});
