export interface MappingSummaryInput {
	placeName: string;
	version: number;
	nodeCount: number;
	scriptCount: number;
	rootCount: number;
	roots: string[];
	lastBuiltAt: number;
	lastReason: string;
}

export interface MappingNodeInput {
	path: string;
	className: string;
	hasSource: boolean;
	subsystem?: string;
}

export interface AgentMappingSnapshot {
	headline: string;
	meta: string;
	context: string;
	roots: string[];
	rootTotal: number;
	subsystems: string[];
	subsystemTotal: number;
	scripts: string[];
	scriptTotal: number;
}

declare const string: {
	sub: (value: string, from: number, to?: number) => string;
};

declare global {
	interface Array<T> {
		size(): number;
	}
}

const ROOT_PREVIEW_LIMIT = 8;
const SUBSYSTEM_PREVIEW_LIMIT = 8;
const SCRIPT_PREVIEW_LIMIT = 8;

function arrayCount<T>(items: T[]): number {
	let count = 0;
	for (const _item of items) {
		count += 1;
	}
	return count;
}

function stringSub(text: string, start: number, finish?: number): string {
	return string.sub(text, start, finish);
}

function stripGamePrefix(path: string): string {
	if (stringSub(path, 1, 5) === "game.") {
		return stringSub(path, 6);
	}
	return path;
}

function insertSortedLimited(items: string[], value: string, limit: number): void {
	let inserted = false;
	for (let index = 0; index < arrayCount(items); index++) {
		if (value < items[index]) {
			items.push(value);
			for (let cursor = arrayCount(items) - 1; cursor > index; cursor--) {
				const temp = items[cursor - 1];
				items[cursor - 1] = items[cursor];
				items[cursor] = temp;
			}
			inserted = true;
			break;
		}
	}

	if (!inserted && arrayCount(items) < limit) {
		items.push(value);
		inserted = true;
	}

	if (!inserted) {
		return;
	}

	if (arrayCount(items) > limit) {
		items.pop();
	}
}

export function buildAgentMappingSnapshot(
	summary: MappingSummaryInput,
	nodes: MappingNodeInput[],
): AgentMappingSnapshot {
	const subsystemCounts = new Map<string, number>();
	const scriptPathsPreview: string[] = [];
	let scriptTotal = 0;

	for (const node of nodes) {
		if (node.subsystem && node.subsystem !== "") {
			subsystemCounts.set(node.subsystem, (subsystemCounts.get(node.subsystem) ?? 0) + 1);
		}
		if (node.hasSource) {
			scriptTotal += 1;
			insertSortedLimited(scriptPathsPreview, stripGamePrefix(node.path), SCRIPT_PREVIEW_LIMIT);
		}
	}

	const rootsPreview: string[] = [];
	for (const root of summary.roots) {
		if (arrayCount(rootsPreview) >= ROOT_PREVIEW_LIMIT) {
			break;
		}
		rootsPreview.push(stripGamePrefix(root));
	}

	const subsystemNames: string[] = [];
	subsystemCounts.forEach((_, name) => {
		subsystemNames.push(name);
	});

	for (let i = 0; i < arrayCount(subsystemNames); i++) {
		for (let j = i + 1; j < arrayCount(subsystemNames); j++) {
			const left = subsystemNames[i];
			const right = subsystemNames[j];
			const leftCount = subsystemCounts.get(left) ?? 0;
			const rightCount = subsystemCounts.get(right) ?? 0;
			const shouldSwap = rightCount > leftCount || (rightCount === leftCount && right < left);
			if (shouldSwap) {
				subsystemNames[i] = right;
				subsystemNames[j] = left;
			}
		}
	}

	const subsystemPreview: string[] = [];
	for (const name of subsystemNames) {
		if (arrayCount(subsystemPreview) >= SUBSYSTEM_PREVIEW_LIMIT) {
			break;
		}
		subsystemPreview.push(`${name} (${subsystemCounts.get(name) ?? 0})`);
	}

	return {
		headline: `${summary.nodeCount} nodes mapped | ${summary.scriptCount} scripts ready`,
		meta: `${summary.rootCount} roots | ${arrayCount(subsystemNames)} subsystems | v${summary.version}`,
		context: `Place ${summary.placeName} | reason ${summary.lastReason}`,
		roots: rootsPreview,
		rootTotal: summary.rootCount,
		subsystems: subsystemPreview,
		subsystemTotal: arrayCount(subsystemNames),
		scripts: scriptPathsPreview,
		scriptTotal,
	};
}
