import StructureMap from "./StructureMap";
import Utils from "./Utils";

export interface ContextFile {
	path: string;
	name: string;
	scriptType: string;
	subsystem: string;
	summaryStatus: "missing" | "fresh" | "stale";
	lastAccessedAt?: number;
	relevanceScore: number;
}

export interface AgentFocusContext {
	agentId: string;
	activeSubsystems: string[];
	lastActiveAt: number;
	loadedFiles: string[];
}

export interface ContextLoadRequest {
	agentId: string;
	subsystems?: string[];
	priority?: "high" | "medium" | "low";
	maxFiles?: number;
}

export interface ContextLoadResult {
	loaded: ContextFile[];
	skipped: string[];
	totalFound: number;
}

const SUBSYSTEM_PRIORITY_KEYWORDS: Record<string, string[]> = {
	AI: ["AI", "Behavior", "Neural", "NPC", "Pathfinding"],
	Combat: ["Combat", "Damage", "Weapon", "Attack", "Defense"],
	Inventory: ["Inventory", "Item", "Bag", "Slot", "Equip"],
	UI: ["UI", "Gui", "Frame", "Button", "HUD"],
	Tycoon: ["Tycoon", "Factory", "Producer", "Automation"],
	Data: ["Data", "Save", "Load", "Store", "Config"],
	Player: ["Player", "Character", "Avatar", "Skin"],
	Shop: ["Shop", "Store", "Purchase", "Currency", "Market"],
	Quest: ["Quest", "Mission", "Objective", "Progress"],
	NPC: ["NPC", "Dialog", "Conversation", "Interaction"],
};

let agentFocusMap = new Map<string, AgentFocusContext>();
let contextCache = new Map<string, ContextFile[]>();
let initialized = false;

function inferSubsystemFromTags(tags: string[]): string | undefined {
	for (const tag of tags) {
		for (const [subsystem, keywords] of pairs(SUBSYSTEM_PRIORITY_KEYWORDS)) {
			for (const keyword of keywords) {
				if (tag.lower().find(keyword.lower())[0] !== undefined) {
					return subsystem;
				}
			}
		}
	}
	return undefined;
}

function calculateRelevanceScore(file: ContextFile, agentContext: AgentFocusContext): number {
	let score = 0;

	for (const subsystem of agentContext.activeSubsystems) {
		if (file.subsystem === subsystem) {
			score += 10;
		}
	}

	if (file.summaryStatus === "stale") {
		score += 5;
	} else if (file.summaryStatus === "missing") {
		score += 3;
	}

	const keywords = SUBSYSTEM_PRIORITY_KEYWORDS[agentContext.activeSubsystems[0]];
	if (keywords) {
		for (const keyword of keywords) {
			if (file.name.lower().find(keyword.lower())[0] !== undefined) {
				score += 2;
			}
		}
	}

	return score;
}

function updateAgentFocus(agentId: string, subsystems: string[]): void {
	const existing = agentFocusMap.get(agentId);
	const updated: AgentFocusContext = {
		agentId,
		activeSubsystems: subsystems,
		lastActiveAt: tick(),
		loadedFiles: existing?.loadedFiles ?? [],
	};
	agentFocusMap.set(agentId, updated);
}

function getAgentFocus(agentId: string): AgentFocusContext | undefined {
	return agentFocusMap.get(agentId);
}

function getAllAgentFocus(): AgentFocusContext[] {
	const result: AgentFocusContext[] = [];
	agentFocusMap.forEach((context) => {
		result.push(context);
	});
	return result;
}

function scanSubsystemFiles(subsystem: string, maxFiles: number = 20): ContextFile[] {
	const structureSummary = StructureMap.getStructureMapSummary();
	if (structureSummary.suspended || structureSummary.pendingBuild) {
		return [];
	}

	const queryResult = StructureMap.queryStructureMap({
		filters: { subsystem: subsystem.lower(), hasSource: true },
		limit: maxFiles * 2,
	});

	if (!queryResult || !queryResult.nodes) {
		return [];
	}

	const files: ContextFile[] = [];
	for (const node of queryResult.nodes) {
		if (files.size() >= maxFiles) break;

		const path = node.path as string;
		const name = node.name as string;
		const scriptType = (node.scriptType as string) ?? node.className as string;
		const summaryStatus = (node.summaryStatus as "missing" | "fresh" | "stale") ?? "missing";

		files.push({
			path,
			name,
			scriptType,
			subsystem,
			summaryStatus,
			relevanceScore: 0,
		});
	}

	return files;
}

function loadContextForAgent(request: ContextLoadRequest): ContextLoadResult {
	const agentContext = agentFocusMap.get(request.agentId);
	const subsystems = request.subsystems ?? agentContext?.activeSubsystems ?? [];

	if (subsystems.size() === 0) {
		const snapshot = StructureMap.getAgentMappingSnapshot();
		for (const ss of snapshot.subsystems) {
			subsystems.push(ss);
		}
	}

	const maxFiles = request.maxFiles ?? 15;
	const loaded: ContextFile[] = [];
	const skipped: string[] = [];
	let totalFound = 0;

	for (const subsystem of subsystems) {
		let subsystemFiles = contextCache.get(subsystem);
		if (!subsystemFiles) {
			subsystemFiles = scanSubsystemFiles(subsystem, maxFiles);
			contextCache.set(subsystem, subsystemFiles);
		}

		totalFound += subsystemFiles.size();

		for (const file of subsystemFiles) {
			if (loaded.size() >= maxFiles) break;

			if (agentContext && loaded.size() < maxFiles) {
				file.relevanceScore = calculateRelevanceScore(file, agentContext);
			}

			if (file.summaryStatus === "stale" || file.summaryStatus === "missing") {
				loaded.push(file);
			} else {
				skipped.push(file.path);
			}
		}
	}

	if (agentContext) {
		agentContext.loadedFiles = loaded.map((f) => f.path);
		agentContext.lastActiveAt = tick();
		agentFocusMap.set(request.agentId, agentContext);
	}

	return {
		loaded,
		skipped,
		totalFound,
	};
}

function refreshContextCache(subsystem?: string): void {
	if (subsystem) {
		contextCache.delete(subsystem);
	} else {
		contextCache.clear();
	}
}

function getContextCacheSize(): number {
	return contextCache.size();
}

function getRelevantFilesForAgent(agentId: string, limit: number = 20): ContextFile[] {
	const agentContext = agentFocusMap.get(agentId);
	if (!agentContext) return [];

	const allFiles: ContextFile[] = [];

	for (const loadedPath of agentContext.loadedFiles) {
		const cached = contextCache.get(loadedPath);
		if (cached) {
			allFiles.push(...cached);
		}
	}

	for (const [, files] of contextCache) {
		for (const file of files) {
			if (!agentContext.loadedFiles.includes(file.path)) {
				allFiles.push(file);
			}
		}
	}

	allFiles.sort((a, b) => b.relevanceScore - a.relevanceScore);
	const sorted: ContextFile[] = [];
	for (let i = 0; i < math.min(limit, allFiles.size()); i++) {
		sorted.push(allFiles[i]);
	}
	return sorted;
}

function invalidateStaleFiles(): number {
	let invalidated = 0;

	contextCache.forEach((files, subsystem) => {
		const updatedFiles = scanSubsystemFiles(subsystem, 20);
		for (const updated of updatedFiles) {
			for (const cached of files) {
				if (cached.path === updated.path) {
					cached.summaryStatus = updated.summaryStatus;
					invalidated += 1;
				}
			}
		}
	});

	return invalidated;
}

function init(): void {
	if (initialized) return;
	initialized = true;
}

function shutdown(): void {
	agentFocusMap.clear();
	contextCache.clear();
	initialized = false;
}

export = {
	init,
	shutdown,
	updateAgentFocus,
	getAgentFocus,
	getAllAgentFocus,
	loadContextForAgent,
	refreshContextCache,
	getContextCacheSize,
	getRelevantFilesForAgent,
	invalidateStaleFiles,
};