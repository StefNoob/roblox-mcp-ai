import { CollectionService, RunService } from "@rbxts/services";
import Utils from "./Utils";
import { buildAgentMappingSnapshot } from "./MappingSummary";
import { shouldSuspendStructureMap } from "./PlaytestGuard";

const { getInstancePath, getInstanceByPath, readScriptSource } = Utils;

type StructureMapMode = "compact" | "standard" | "verbose";

type SummaryStatus = "missing" | "fresh" | "stale";

interface StructureMapNodeRecord {
	path: string;
	name: string;
	className: string;
	parentPath?: string;
	childPaths: string[];
	childCount: number;
	hasChildren: boolean;
	hasSource: boolean;
	scriptType?: string;
	enabled?: boolean;
	tags?: string[];
	attributeNames?: string[];
	sourceHash?: string;
	summaryStatus: SummaryStatus;
	subsystem?: string;
}

interface QueryFilters {
	pathPrefix?: string;
	className?: string;
	hasSource?: boolean;
	scriptType?: string;
	subsystem?: string;
	summaryStatus?: SummaryStatus;
	nameQuery?: string;
	limit?: number;
}

let initialized = false;
let dirty = true;
let version = 0;
let lastBuiltAt = 0;
let lastReason = "startup";
const nodesByPath = new Map<string, StructureMapNodeRecord>();
const roots: string[] = [];
const summaryHashesByPath = new Map<string, string>();
let descendantAddedConnection: RBXScriptConnection | undefined;
let descendantRemovingConnection: RBXScriptConnection | undefined;

function arrayCount<T>(items: T[]): number {
	let count = 0;
	for (const _item of items) {
		count += 1;
	}
	return count;
}

function isStructureMapSuspended(): boolean {
	let isRunning = false;
	let isEdit = false;

	try {
		isRunning = RunService.IsRunning() === true;
	} catch {
		isRunning = false;
	}

	try {
		isEdit = RunService.IsEdit() === true;
	} catch {
		isEdit = false;
	}

	if (isRunning && isEdit) {
		isEdit = false;
	}

	return shouldSuspendStructureMap({ isRunning, isEdit });
}

function buildSuspendedAgentMappingSnapshot() {
	return {
		headline: "Structure map suspended during playtest",
		meta: "Playtest runtime data is excluded to keep MCP stable",
		context: "Stop playtest to refresh the edit-time structure map",
		roots: [],
		rootTotal: 0,
		subsystems: [],
		subsystemTotal: 0,
		scripts: [],
		scriptTotal: 0,
	};
}

function buildPendingAgentMappingSnapshot() {
	return {
		headline: "Structure map is idle",
		meta: "No live snapshot built yet",
		context: "Connect and refresh structure map when you need map-aware context",
		roots: [],
		rootTotal: 0,
		subsystems: [],
		subsystemTotal: 0,
		scripts: [],
		scriptTotal: 0,
		pendingBuild: true,
	};
}

function inferSubsystem(path: string): string | undefined {
	const cleaned = path.gsub("^game%.", "")[0];
	const segments = cleaned.split(".");
	const keywords = ["AI", "Combat", "Inventory", "UI", "Tycoon", "Data", "Player", "Shop", "Quest", "NPC"];
	for (const segment of segments) {
		for (const keyword of keywords) {
			if (segment.lower().find(keyword.lower())[0] !== undefined) {
				return keyword;
			}
		}
	}
	return arrayCount(segments) >= 2 ? segments[1] : undefined;
}

function hashText(text: string): string {
	let hash = 2166136261;
	for (let i = 0; i < text.size(); i++) {
		const [code] = string.byte(text, i + 1) as LuaTuple<[number]>;
		hash = bit32.bxor(hash, code);
		hash = bit32.band(hash * 16777619, 0xffffffff);
	}
	return `fnv32:${string.format("%08x", hash)}`;
}

function snapshotNode(instance: Instance): StructureMapNodeRecord {
	const path = getInstancePath(instance);
	const childPaths = instance.GetChildren().map((child) => getInstancePath(child));
	const childCount = arrayCount(childPaths);
	const tags = CollectionService.GetTags(instance);
	const attributeNames: string[] = [];
	for (const [name] of pairs(instance.GetAttributes())) {
		attributeNames.push(name as string);
	}

	const node: StructureMapNodeRecord = {
		path,
		name: instance.Name,
		className: instance.ClassName,
		parentPath: instance.Parent ? getInstancePath(instance.Parent) : undefined,
		childPaths,
		childCount,
		hasChildren: childCount > 0,
		hasSource: instance.IsA("LuaSourceContainer"),
		summaryStatus: "missing",
		subsystem: inferSubsystem(path),
	};

	if (instance.IsA("LuaSourceContainer")) {
		node.scriptType = instance.ClassName;
	}
	if (instance.IsA("BaseScript")) {
		node.enabled = instance.Enabled;
	}
	if (arrayCount(tags) > 0) {
		node.tags = tags;
	}
	if (arrayCount(attributeNames) > 0) {
		node.attributeNames = attributeNames;
	}

	return node;
}

function rebuild() {
	nodesByPath.clear();
	roots.clear();
	const stack: Instance[] = [];

	for (const child of game.GetChildren()) {
		roots.push(getInstancePath(child));
		stack.push(child);
	}

	while (arrayCount(stack) > 0) {
		const instance = stack.pop();
		if (!instance) {
			continue;
		}
		const node = snapshotNode(instance);
		nodesByPath.set(node.path, node);
		for (const child of instance.GetChildren()) {
			stack.push(child);
		}
	}

	version += 1;
	lastBuiltAt = tick();
	dirty = false;
}

function ensureFresh(autoBuild: boolean = true): boolean {
	if (isStructureMapSuspended()) {
		return false;
	}
	if (dirty || nodesByPath.size() === 0) {
		if (!autoBuild) {
			return false;
		}
		rebuild();
	}
	return true;
}

function markDirty(reason: string = "unknown") {
	dirty = true;
	lastReason = reason;
}

function ensureScriptHashes() {
	if (isStructureMapSuspended()) {
		return;
	}
	if (!ensureFresh()) {
		return;
	}
	for (const [, node] of nodesByPath) {
		if (!node.hasSource) continue;
		const instance = getInstanceByPath(node.path);
		if (instance && instance.IsA("LuaSourceContainer")) {
			const source = readScriptSource(instance);
			node.sourceHash = hashText(source);
			const cachedSummaryHash = summaryHashesByPath.get(node.path);
			if (!cachedSummaryHash) {
				node.summaryStatus = "missing";
			} else if (cachedSummaryHash === node.sourceHash) {
				node.summaryStatus = "fresh";
			} else {
				node.summaryStatus = "stale";
			}
		}
	}
}

function touchScriptSummary(path: string, sourceHash?: string) {
	ensureScriptHashes();
	const node = nodesByPath.get(path);
	if (!node || !node.hasSource) {
		return;
	}
	const hash = sourceHash ?? node.sourceHash;
	if (!hash) {
		return;
	}
	summaryHashesByPath.set(path, hash);
	node.summaryStatus = "fresh";
}

function shapeNode(node: StructureMapNodeRecord, mode: StructureMapMode): Record<string, unknown> {
	const compact: Record<string, unknown> = {
		path: node.path,
		name: node.name,
		className: node.className,
		hasSource: node.hasSource,
		subsystem: node.subsystem,
	};
	if (mode === "compact") {
		return compact;
	}

	const standard: Record<string, unknown> = {
		...compact,
		parentPath: node.parentPath,
		childCount: node.childCount,
		scriptType: node.scriptType,
		enabled: node.enabled,
		summaryStatus: node.summaryStatus,
		sourceHash: node.sourceHash,
	};
	if (mode === "standard") {
		return standard;
	}

	return {
		...standard,
		childPaths: node.childPaths,
		tags: node.tags ?? [],
		attributeNames: node.attributeNames ?? [],
		hasChildren: node.hasChildren,
	};
}

function getStructureMapSummary(_requestData?: Record<string, unknown>) {
	if (isStructureMapSuspended()) {
		return {
			placeId: game.PlaceId,
			placeName: game.Name,
			version,
			nodeCount: nodesByPath.size(),
			scriptCount: 0,
			rootCount: arrayCount(roots),
			roots,
			dirty: true,
			lastBuiltAt,
			lastReason: "playtest-suspended",
			suspended: true,
		};
	}
	const autoBuild = _requestData?.autoBuild !== false;
	if (!ensureFresh(autoBuild)) {
		return {
			placeId: game.PlaceId,
			placeName: game.Name,
			version,
			nodeCount: nodesByPath.size(),
			scriptCount: 0,
			rootCount: arrayCount(roots),
			roots,
			dirty: true,
			lastBuiltAt,
			lastReason,
			pendingBuild: true,
		};
	}
	let scriptCount = 0;
	for (const [, node] of nodesByPath) {
		if (node.hasSource) scriptCount += 1;
	}

	return {
		placeId: game.PlaceId,
		placeName: game.Name,
		version,
		nodeCount: nodesByPath.size(),
		scriptCount,
		rootCount: arrayCount(roots),
		roots,
		dirty,
		lastBuiltAt,
		lastReason,
	};
}

function queryStructureMap(requestData: Record<string, unknown>) {
	if (isStructureMapSuspended()) {
		return {
			placeId: game.PlaceId,
			placeName: game.Name,
			version,
			mode: (requestData.mode as StructureMapMode | undefined) ?? "compact",
			count: 0,
			nodes: [],
			suspended: true,
		};
	}
	const autoBuild = requestData.autoBuild !== false;
	if (!ensureFresh(autoBuild)) {
		return {
			placeId: game.PlaceId,
			placeName: game.Name,
			version,
			mode: (requestData.mode as StructureMapMode | undefined) ?? "compact",
			count: 0,
			nodes: [],
			pendingBuild: true,
		};
	}
	const mode = (requestData.mode as StructureMapMode | undefined) ?? "compact";
	const filters = (requestData.filters as QueryFilters | undefined) ?? {};

	const limit = filters.limit ?? 250;
	const pathPrefix = filters.pathPrefix?.lower();
	const className = filters.className?.lower();
	const scriptType = filters.scriptType?.lower();
	const subsystem = filters.subsystem?.lower();
	const summaryStatus = filters.summaryStatus;
	const nameQuery = filters.nameQuery?.lower();

	const matches: Record<string, unknown>[] = [];
	for (const [, node] of nodesByPath) {
		if (pathPrefix && node.path.lower().find(pathPrefix)[0] === undefined) continue;
		if (className && node.className.lower() !== className) continue;
		if (filters.hasSource !== undefined && node.hasSource !== filters.hasSource) continue;
		if (scriptType && (node.scriptType ?? "").lower() !== scriptType) continue;
		if (subsystem && (node.subsystem ?? "").lower() !== subsystem) continue;
		if (summaryStatus && node.summaryStatus !== summaryStatus) continue;
		if (nameQuery && node.name.lower().find(nameQuery)[0] === undefined) continue;

		matches.push(shapeNode(node, mode));
		if (arrayCount(matches) >= limit) break;
	}

	return {
		placeId: game.PlaceId,
		placeName: game.Name,
		version,
		mode,
		count: arrayCount(matches),
		nodes: matches,
	};
}

function getScriptInventory(requestData: Record<string, unknown>) {
	if (isStructureMapSuspended()) {
		return {
			placeId: game.PlaceId,
			placeName: game.Name,
			version,
			mode: (requestData.mode as StructureMapMode | undefined) ?? "compact",
			count: 0,
			scripts: [],
			suspended: true,
		};
	}
	const mode = (requestData.mode as StructureMapMode | undefined) ?? "compact";
	if (requestData.autoBuild === false && (dirty || nodesByPath.size() === 0)) {
		return {
			placeId: game.PlaceId,
			placeName: game.Name,
			version,
			mode,
			count: 0,
			scripts: [],
			pendingBuild: true,
		};
	}
	ensureScriptHashes();
	const scripts = [...nodesByPath]
		.map(([, node]) => node)
		.filter((node) => node.hasSource)
		.map((node) => shapeNode(node, mode));

	return {
		placeId: game.PlaceId,
		placeName: game.Name,
		version,
		mode,
		count: arrayCount(scripts),
		scripts,
	};
}

function getAgentMappingSnapshot(requestData?: Record<string, unknown>) {
	if (isStructureMapSuspended()) {
		return buildSuspendedAgentMappingSnapshot();
	}
	const autoBuild = requestData?.autoBuild !== false;
	if (!ensureFresh(autoBuild)) {
		return buildPendingAgentMappingSnapshot();
	}
	let scriptCount = 0;
	const nodes = [...nodesByPath].map(([, node]) => {
		if (node.hasSource) {
			scriptCount += 1;
		}
		return {
			path: node.path,
			className: node.className,
			hasSource: node.hasSource,
			subsystem: node.subsystem,
		};
	});

	return buildAgentMappingSnapshot(
		{
			placeName: game.Name,
			version,
			nodeCount: nodesByPath.size(),
			scriptCount,
			rootCount: arrayCount(roots),
			roots,
			lastBuiltAt,
			lastReason,
		},
		nodes,
	);
}

function refreshStructureMap(_requestData?: Record<string, unknown>) {
	if (isStructureMapSuspended()) {
		return {
			success: true,
			suspended: true,
			...getStructureMapSummary(),
		};
	}
	rebuild();
	return {
		success: true,
		...getStructureMapSummary(),
	};
}

function init() {
	if (initialized) return;
	initialized = true;

	descendantAddedConnection = game.DescendantAdded.Connect((instance) => {
		if (isStructureMapSuspended()) {
			return;
		}
		markDirty("descendant-added");
	});
	descendantRemovingConnection = game.DescendantRemoving.Connect((instance) => {
		if (isStructureMapSuspended()) {
			return;
		}
		markDirty("descendant-removing");
	});
}

function shutdown() {
	descendantAddedConnection?.Disconnect();
	descendantRemovingConnection?.Disconnect();
	descendantAddedConnection = undefined;
	descendantRemovingConnection = undefined;
	initialized = false;
	dirty = true;
	summaryHashesByPath.clear();
	nodesByPath.clear();
	roots.clear();
}

export = {
	init,
	shutdown,
	markDirty,
	getStructureMapSummary,
	queryStructureMap,
	getScriptInventory,
	getAgentMappingSnapshot,
	refreshStructureMap,
	touchScriptSummary,
};
