import { CollectionService } from "@rbxts/services";
import Utils from "./Utils";

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
const watchedNodes = new Map<Instance, RBXScriptConnection[]>();
let descendantAddedConnection: RBXScriptConnection | undefined;
let descendantRemovingConnection: RBXScriptConnection | undefined;

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
	return segments.size() >= 2 ? segments[1] : undefined;
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

function watchNode(instance: Instance) {
	if (watchedNodes.has(instance)) return;
	const connections: RBXScriptConnection[] = [];
	connections.push(instance.GetPropertyChangedSignal("Name").Connect(() => markDirty("rename")));
	connections.push(instance.AncestryChanged.Connect(() => markDirty("ancestry")));
	watchedNodes.set(instance, connections);
}

function unwatchNode(instance: Instance) {
	const existing = watchedNodes.get(instance);
	if (!existing) return;
	for (const connection of existing) {
		connection.Disconnect();
	}
	watchedNodes.delete(instance);
}

function snapshotNode(instance: Instance): StructureMapNodeRecord {
	const path = getInstancePath(instance);
	const childPaths = instance.GetChildren().map((child) => getInstancePath(child));
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
		childCount: childPaths.size(),
		hasChildren: childPaths.size() > 0,
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
	if (tags.size() > 0) {
		node.tags = tags;
	}
	if (attributeNames.size() > 0) {
		node.attributeNames = attributeNames;
	}

	return node;
}

function rebuild() {
	nodesByPath.clear();
	roots.clear();

	for (const [instance] of watchedNodes) {
		unwatchNode(instance);
	}

	const visit = (instance: Instance) => {
		watchNode(instance);
		const node = snapshotNode(instance);
		nodesByPath.set(node.path, node);
		for (const child of instance.GetChildren()) {
			visit(child);
		}
	};

	for (const child of game.GetChildren()) {
		roots.push(getInstancePath(child));
		visit(child);
	}

	version += 1;
	lastBuiltAt = tick();
	dirty = false;
}

function ensureFresh() {
	if (dirty || nodesByPath.size() === 0) {
		rebuild();
	}
}

function markDirty(reason: string = "unknown") {
	dirty = true;
	lastReason = reason;
}

function ensureScriptHashes() {
	ensureFresh();
	for (const [, node] of nodesByPath) {
		if (!node.hasSource) continue;
		const instance = getInstanceByPath(node.path);
		if (instance && instance.IsA("LuaSourceContainer")) {
			const source = readScriptSource(instance);
			node.sourceHash = hashText(source);
		}
	}
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
	ensureFresh();
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
		rootCount: roots.size(),
		roots,
		dirty,
		lastBuiltAt,
		lastReason,
	};
}

function queryStructureMap(requestData: Record<string, unknown>) {
	ensureFresh();
	const mode = (requestData.mode as StructureMapMode | undefined) ?? "compact";
	const filters = (requestData.filters as QueryFilters | undefined) ?? {};

	const limit = filters.limit ?? 250;
	const pathPrefix = filters.pathPrefix?.lower();
	const className = filters.className?.lower();
	const scriptType = filters.scriptType?.lower();
	const subsystem = filters.subsystem?.lower();
	const nameQuery = filters.nameQuery?.lower();

	const matches: Record<string, unknown>[] = [];
	for (const [, node] of nodesByPath) {
		if (pathPrefix && node.path.lower().find(pathPrefix)[0] === undefined) continue;
		if (className && node.className.lower() !== className) continue;
		if (filters.hasSource !== undefined && node.hasSource !== filters.hasSource) continue;
		if (scriptType && (node.scriptType ?? "").lower() !== scriptType) continue;
		if (subsystem && (node.subsystem ?? "").lower() !== subsystem) continue;
		if (nameQuery && node.name.lower().find(nameQuery)[0] === undefined) continue;

		matches.push(shapeNode(node, mode));
		if (matches.size() >= limit) break;
	}

	return {
		placeId: game.PlaceId,
		placeName: game.Name,
		version,
		mode,
		count: matches.size(),
		nodes: matches,
	};
}

function getScriptInventory(requestData: Record<string, unknown>) {
	const mode = (requestData.mode as StructureMapMode | undefined) ?? "compact";
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
		count: scripts.size(),
		scripts,
	};
}

function refreshStructureMap(_requestData?: Record<string, unknown>) {
	rebuild();
	ensureScriptHashes();
	return {
		success: true,
		...getStructureMapSummary(),
	};
}

function init() {
	if (initialized) return;
	initialized = true;

	descendantAddedConnection = game.DescendantAdded.Connect((instance) => {
		watchNode(instance);
		markDirty("descendant-added");
	});
	descendantRemovingConnection = game.DescendantRemoving.Connect((instance) => {
		unwatchNode(instance);
		markDirty("descendant-removing");
	});

	rebuild();
}

function shutdown() {
	descendantAddedConnection?.Disconnect();
	descendantRemovingConnection?.Disconnect();
	descendantAddedConnection = undefined;
	descendantRemovingConnection = undefined;
	for (const [instance] of watchedNodes) {
		unwatchNode(instance);
	}
	initialized = false;
	dirty = true;
}

export = {
	init,
	shutdown,
	markDirty,
	getStructureMapSummary,
	queryStructureMap,
	getScriptInventory,
	refreshStructureMap,
};
