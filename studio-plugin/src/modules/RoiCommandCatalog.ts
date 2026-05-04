export interface RoiUiCommand {
	name: string;
	description: string;
	endpoint: string;
	params?: Record<string, unknown>;
}

export function buildRoiUiCommands(): RoiUiCommand[] {
	return [
		{
			name: "Luau Diagnostics",
			description: "Run static Luau diagnostics on a starter script path.",
			endpoint: "/mcp/get_luau_diagnostics",
			params: {
				instancePaths: ["game.ServerScriptService.Main"],
				includeSourceHints: false,
			},
		},
		{
			name: "Open Debug Log Stream",
			description: "Create a log cursor for incremental error polling.",
			endpoint: "/mcp/open_debug_log_stream",
			params: {
				type: "errors",
			},
		},
		{
			name: "Capture Perf Snapshot",
			description: "Collect 3 samples and summarize FPS and memory.",
			endpoint: "/mcp/capture_performance_snapshot",
			params: {
				category: "all",
				sampleCount: 3,
				intervalMs: 250,
			},
		},
		{
			name: "Replace Script Function",
			description: "Replace a named Luau function block using MCP semantic edit.",
			endpoint: "/mcp/replace_script_function",
			params: {
				instancePath: "game.ServerScriptService.Main",
				functionName: "Main.init",
				newFunctionContent: "function Main.init()\n\treturn nil\nend",
			},
		},
	];
}
