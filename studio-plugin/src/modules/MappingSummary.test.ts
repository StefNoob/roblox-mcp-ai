import { buildAgentMappingSnapshot } from "./MappingSummary";

beforeAll(() => {
	(globalThis as { string?: { sub: (value: string, from: number, to?: number) => string } }).string = {
		sub: (value: string, from: number, to?: number) => {
			const zeroStart = from - 1;
			if (to !== undefined) {
				return value.substring(zeroStart, to);
			}
			return value.substring(zeroStart);
		},
	};
	(Array.prototype as Array<unknown> & { size?: () => number }).size = function size() {
		return this.length;
	};
});

describe("buildAgentMappingSnapshot", () => {
	it("summarizes mapped roots, subsystems, and scripts for the overview UI", () => {
		const snapshot = buildAgentMappingSnapshot(
			{
				placeName: "Arena",
				version: 3,
				nodeCount: 12,
				scriptCount: 4,
				rootCount: 3,
				roots: [
					"game.Workspace",
					"game.ReplicatedStorage",
					"game.ServerScriptService",
				],
				lastBuiltAt: 123,
				lastReason: "refresh",
			},
			[
				{ path: "game.Workspace.UI.HUDController", className: "LocalScript", hasSource: true, subsystem: "UI" },
				{ path: "game.Workspace.UI.MenuController", className: "LocalScript", hasSource: true, subsystem: "UI" },
				{ path: "game.ServerScriptService.Combat.NPCAI", className: "Script", hasSource: true, subsystem: "Combat" },
				{ path: "game.ServerScriptService.Combat.DamageService", className: "ModuleScript", hasSource: true, subsystem: "Combat" },
				{ path: "game.ReplicatedStorage.Inventory.ItemDefs", className: "ModuleScript", hasSource: false, subsystem: "Inventory" },
			],
		);

		expect(snapshot.headline).toBe("12 nodes mapped | 4 scripts ready");
		expect(snapshot.meta).toBe("3 roots | 3 subsystems | v3");
		expect(snapshot.context).toBe("Place Arena | reason refresh");
		expect(snapshot.roots).toEqual(["Workspace", "ReplicatedStorage", "ServerScriptService"]);
		expect(snapshot.rootTotal).toBe(3);
		expect(snapshot.subsystems).toEqual(["Combat (2)", "UI (2)", "Inventory (1)"]);
		expect(snapshot.subsystemTotal).toBe(3);
		expect(snapshot.scripts).toEqual([
			"ServerScriptService.Combat.DamageService",
			"ServerScriptService.Combat.NPCAI",
			"Workspace.UI.HUDController",
			"Workspace.UI.MenuController",
		]);
		expect(snapshot.scriptTotal).toBe(4);
	});

	it("returns stable empty-state strings when nothing is mapped yet", () => {
		const snapshot = buildAgentMappingSnapshot(
			{
				placeName: "Arena",
				version: 0,
				nodeCount: 0,
				scriptCount: 0,
				rootCount: 0,
				roots: [],
				lastBuiltAt: 0,
				lastReason: "startup",
			},
			[],
		);

		expect(snapshot.headline).toBe("0 nodes mapped | 0 scripts ready");
		expect(snapshot.meta).toBe("0 roots | 0 subsystems | v0");
		expect(snapshot.context).toBe("Place Arena | reason startup");
		expect(snapshot.roots).toEqual([]);
		expect(snapshot.rootTotal).toBe(0);
		expect(snapshot.subsystems).toEqual([]);
		expect(snapshot.subsystemTotal).toBe(0);
		expect(snapshot.scripts).toEqual([]);
		expect(snapshot.scriptTotal).toBe(0);
	});

	it("caps script previews for large maps while preserving the total script count", () => {
		const nodes = Array.from({ length: 20 }, (_, index) => ({
			path: `game.ServerScriptService.System.Script${String.fromCharCode(90 - index)}`,
			className: "ModuleScript",
			hasSource: true,
			subsystem: "System",
		}));

		const snapshot = buildAgentMappingSnapshot(
			{
				placeName: "Arena",
				version: 4,
				nodeCount: 2000,
				scriptCount: 20,
				rootCount: 1,
				roots: ["game.ServerScriptService"],
				lastBuiltAt: 456,
				lastReason: "refresh",
			},
			nodes,
		);

		expect(snapshot.scriptTotal).toBe(20);
		expect(snapshot.scripts).toEqual([
			"ServerScriptService.System.ScriptG",
			"ServerScriptService.System.ScriptH",
			"ServerScriptService.System.ScriptI",
			"ServerScriptService.System.ScriptJ",
			"ServerScriptService.System.ScriptK",
			"ServerScriptService.System.ScriptL",
			"ServerScriptService.System.ScriptM",
			"ServerScriptService.System.ScriptN",
		]);
	});
});

