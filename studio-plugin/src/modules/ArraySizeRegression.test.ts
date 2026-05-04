import { readFileSync } from "node:fs";

function read(path: string) {
	return readFileSync(path, "utf8");
}

describe("compiled plugin avoids :size() on plain arrays", () => {
	it("does not emit array :size() calls in startup-critical modules", () => {
		const files = [
			"C:/roblox-mcp-ai/studio-plugin/out/modules/State.luau",
			"C:/roblox-mcp-ai/studio-plugin/out/modules/UI.luau",
			"C:/roblox-mcp-ai/studio-plugin/out/modules/Communication.luau",
			"C:/roblox-mcp-ai/studio-plugin/out/modules/StructureMap.luau",
			"C:/roblox-mcp-ai/studio-plugin/out/modules/Utils.luau",
			"C:/roblox-mcp-ai/studio-plugin/out/modules/MappingSummary.luau",
			"C:/roblox-mcp-ai/studio-plugin/out/server/init.server.luau",
		];

		for (const file of files) {
			expect(read(file)).not.toMatch(/:size\(\)/);
		}
	});
});
