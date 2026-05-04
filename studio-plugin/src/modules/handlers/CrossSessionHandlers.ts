import { CollectionService, HttpService } from "@rbxts/services";
import Utils from "../Utils";

const ScriptEditorService = game.GetService("ScriptEditorService");
const ChangeHistoryService = game.GetService("ChangeHistoryService");

const { getInstancePath, getInstanceByPath, readScriptSource } = Utils;

type SnapshotNode = {
	className: string;
	name: string;
	relativePath: string;
	properties: Record<string, unknown>;
	attributes: Record<string, { value: unknown; type: string }>;
	tags: string[];
	source?: string;
	children: SnapshotNode[];
};

type DeferredReference = {
	instance: Instance;
	propertyName: string;
	targetRelativePath: string;
};

const COMMON_PROPERTIES = ["Archivable"];
const BASE_PART_PROPERTIES = [
	"Anchored", "CanCollide", "CanTouch", "CanQuery", "Transparency", "Material", "Color",
	"Size", "CFrame", "CastShadow", "Locked", "Massless",
];
const MODEL_PROPERTIES = ["WorldPivot"];
const ATTACHMENT_PROPERTIES = ["Position", "Orientation", "Axis", "SecondaryAxis", "Visible"];
const PROXIMITY_PROMPT_PROPERTIES = [
	"ActionText", "ObjectText", "KeyboardKeyCode", "GamepadKeyCode", "HoldDuration",
	"MaxActivationDistance", "RequiresLineOfSight", "ClickablePrompt", "Enabled", "Style",
];
const GUI_PROPERTIES = [
	"Visible", "Active", "ZIndex", "BackgroundTransparency", "BackgroundColor3", "Size", "Position",
];
const BASE_SCRIPT_PROPERTIES = ["Enabled", "Disabled"];

function arrayCount<T>(items: T[]): number {
	let count = 0;
	for (const _item of items) {
		count += 1;
	}
	return count;
}

function isTable(value: unknown): value is Record<string, unknown> {
	return typeIs(value, "table");
}

function joinRelativePath(parentPath: string, name: string): string {
	if (parentPath === "") return name;
	return `${parentPath}/${name}`;
}

function getRelativePath(root: Instance, instance: Instance): string {
	if (instance === root) return "";
	const parts: string[] = [];
	let current: Instance | undefined = instance;
	while (current && current !== root && current !== game) {
		parts.unshift(current.Name);
		current = current.Parent as Instance | undefined;
	}
	return parts.join("/");
}

function getPropertyAllowlist(instance: Instance): string[] {
	const allow = [...COMMON_PROPERTIES];
	if (instance.IsA("BasePart")) {
		for (const prop of BASE_PART_PROPERTIES) allow.push(prop);
	}
	if (instance.IsA("Model")) {
		for (const prop of MODEL_PROPERTIES) allow.push(prop);
	}
	if (instance.IsA("Attachment")) {
		for (const prop of ATTACHMENT_PROPERTIES) allow.push(prop);
	}
	if (instance.IsA("ProximityPrompt")) {
		for (const prop of PROXIMITY_PROMPT_PROPERTIES) allow.push(prop);
	}
	if (instance.IsA("GuiObject")) {
		for (const prop of GUI_PROPERTIES) allow.push(prop);
	}
	if (instance.IsA("BaseScript")) {
		for (const prop of BASE_SCRIPT_PROPERTIES) allow.push(prop);
	}
	return allow;
}

function serializeValue(value: unknown): unknown {
	const valueType = typeOf(value);
	if (valueType === "nil" || valueType === "boolean" || valueType === "number" || valueType === "string") {
		return value;
	}
	if (valueType === "Vector2") {
		const v = value as Vector2;
		return { _type: "Vector2", x: v.X, y: v.Y };
	}
	if (valueType === "Vector3") {
		const v = value as Vector3;
		return { _type: "Vector3", x: v.X, y: v.Y, z: v.Z };
	}
	if (valueType === "Color3") {
		const v = value as Color3;
		return { _type: "Color3", r: v.R, g: v.G, b: v.B };
	}
	if (valueType === "BrickColor") {
		const v = value as BrickColor;
		return { _type: "BrickColor", name: v.Name };
	}
	if (valueType === "UDim") {
		const v = value as UDim;
		return { _type: "UDim", scale: v.Scale, offset: v.Offset };
	}
	if (valueType === "UDim2") {
		const v = value as UDim2;
		return {
			_type: "UDim2",
			x: { scale: v.X.Scale, offset: v.X.Offset },
			y: { scale: v.Y.Scale, offset: v.Y.Offset },
		};
	}
	if (valueType === "CFrame") {
		const v = value as CFrame;
		const components = v.GetComponents();
		return {
			_type: "CFrame",
			components: [
				components[0], components[1], components[2],
				components[3], components[4], components[5],
				components[6], components[7], components[8],
				components[9], components[10], components[11],
			],
		};
	}
	if (valueType === "EnumItem") {
		const enumValue = value as EnumItem;
		return {
			_type: "EnumItem",
			enumType: tostring(enumValue.EnumType),
			name: enumValue.Name,
		};
	}
	return undefined;
}

function deserializeValue(value: unknown): unknown {
	if (!isTable(value)) return value;
	const taggedType = value._type;
	if (taggedType === "Vector2") {
		return new Vector2((value.x as number) ?? 0, (value.y as number) ?? 0);
	}
	if (taggedType === "Vector3") {
		return new Vector3((value.x as number) ?? 0, (value.y as number) ?? 0, (value.z as number) ?? 0);
	}
	if (taggedType === "Color3") {
		return new Color3((value.r as number) ?? 0, (value.g as number) ?? 0, (value.b as number) ?? 0);
	}
	if (taggedType === "BrickColor") {
		return new BrickColor(((value.name as string) ?? "Medium stone grey") as unknown as number);
	}
	if (taggedType === "UDim") {
		return new UDim((value.scale as number) ?? 0, (value.offset as number) ?? 0);
	}
	if (taggedType === "UDim2") {
		const x = value.x as Record<string, number> | undefined;
		const y = value.y as Record<string, number> | undefined;
		return new UDim2(
			x?.scale ?? 0,
			x?.offset ?? 0,
			y?.scale ?? 0,
			y?.offset ?? 0,
		);
	}
	if (taggedType === "CFrame") {
		const components = value.components as number[] | undefined;
		if (!components || arrayCount(components as defined[]) !== 12) return undefined;
		return new CFrame(
			(components[0] ?? 0) as number,
			(components[1] ?? 0) as number,
			(components[2] ?? 0) as number,
			(components[3] ?? 1) as number,
			(components[4] ?? 0) as number,
			(components[5] ?? 0) as number,
			(components[6] ?? 0) as number,
			(components[7] ?? 1) as number,
			(components[8] ?? 0) as number,
			(components[9] ?? 0) as number,
			(components[10] ?? 0) as number,
			(components[11] ?? 1) as number,
		);
	}
	if (taggedType === "EnumItem") {
		const enumType = value.enumType as string | undefined;
		const enumName = value.name as string | undefined;
		if (!enumType || !enumName) return undefined;
		const enumContainer = (Enum as unknown as Record<string, Record<string, EnumItem>>)[enumType];
		if (!enumContainer) return undefined;
		return enumContainer[enumName];
	}
	return value;
}

function serializeInstance(
	root: Instance,
	instance: Instance,
	relativePath: string,
	includeScripts: boolean,
	maxDepth: number,
	depth: number,
	warnings: string[],
): SnapshotNode {
	if (depth > maxDepth) {
		error(`Snapshot depth exceeded maxDepth=${maxDepth}`);
	}

	const properties: Record<string, unknown> = {};
	for (const propertyName of getPropertyAllowlist(instance)) {
		const [ok, value] = pcall(() => (instance as unknown as Record<string, unknown>)[propertyName]);
		if (!ok) continue;
		if (typeOf(value) === "Instance") {
			const target = value as Instance;
			if (target && (target === root || target.IsDescendantOf(root))) {
				properties[propertyName] = {
					_type: "InstanceRef",
					path: getRelativePath(root, target),
				};
			}
			continue;
		}
		const serialized = serializeValue(value);
		if (serialized !== undefined) {
			properties[propertyName] = serialized;
		}
	}

	const attributes: Record<string, { value: unknown; type: string }> = {};
	const rawAttributes = instance.GetAttributes();
	for (const [attributeName, attributeValue] of pairs(rawAttributes)) {
		const serializedAttribute = serializeValue(attributeValue);
		if (serializedAttribute !== undefined) {
			attributes[attributeName as string] = {
				value: serializedAttribute,
				type: typeOf(attributeValue),
			};
		}
	}

	const tags = CollectionService.GetTags(instance);
	const node: SnapshotNode = {
		className: instance.ClassName,
		name: instance.Name,
		relativePath,
		properties,
		attributes,
		tags,
		children: [],
	};

	if (includeScripts && instance.IsA("LuaSourceContainer")) {
		node.source = readScriptSource(instance);
	}

	for (const child of instance.GetChildren()) {
		const childPath = joinRelativePath(relativePath, child.Name);
		const childNode = serializeInstance(root, child, childPath, includeScripts, maxDepth, depth + 1, warnings);
		node.children.push(childNode);
	}

	if (arrayCount(node.children) > 5000) {
		warnings.push(`Large subtree under ${relativePath === "" ? instance.Name : relativePath}`);
	}
	return node;
}

function countSnapshotNodes(node: SnapshotNode): number {
	let count = 1;
	for (const child of node.children) {
		count += countSnapshotNodes(child);
	}
	return count;
}

function resolveRootName(parent: Instance, requestedName: string, policy: string): LuaTuple<[boolean, string]> {
	const existing = parent.FindFirstChild(requestedName);
	if (!existing) {
		return $tuple(true, requestedName);
	}
	if (policy === "replace") {
		existing.Destroy();
		return $tuple(true, requestedName);
	}
	if (policy === "fail") {
		return $tuple(false, `Target already contains '${requestedName}'`);
	}
	let suffix = 1;
	while (suffix < 1000) {
		const candidate = `${requestedName}_Copy${suffix}`;
		if (!parent.FindFirstChild(candidate)) {
			return $tuple(true, candidate);
		}
		suffix += 1;
	}
	return $tuple(false, `Could not resolve collision for '${requestedName}'`);
}

function applyScriptSource(instance: LuaSourceContainer, source: string) {
	const [updateOk, updateErr] = pcall(() => {
		ScriptEditorService.UpdateSourceAsync(instance, () => source);
	});
	if (updateOk) return true;
	const [directOk, directErr] = pcall(() => {
		(instance as unknown as { Source: string }).Source = source;
	});
	if (directOk) return true;
	error(`Failed to set script source: ${tostring(updateErr)} | ${tostring(directErr)}`);
}

function instantiateFromSnapshot(
	node: SnapshotNode,
	parent: Instance,
	pathToInstance: Map<string, Instance>,
	deferredRefs: DeferredReference[],
	warnings: string[],
	namePrefix: string,
	nameSuffix: string,
	scriptReplacements: Array<{ find: string; replace: string }>,
	rootOverrideName?: string,
): Instance {
	let className = node.className;
	let instance: Instance | undefined;

	const [createOk, created] = pcall(() => new Instance(className as keyof CreatableInstances));
	if (createOk && created) {
		instance = created;
	} else {
		className = "Folder";
		instance = new Instance("Folder");
		warnings.push(`Fallback class '${node.className}' -> 'Folder' for '${node.relativePath}'`);
	}

	const isRoot = node.relativePath === "";
	if (isRoot && rootOverrideName && rootOverrideName !== "") {
		instance.Name = rootOverrideName;
	} else {
		instance.Name = `${namePrefix}${node.name}${nameSuffix}`;
	}
	instance.Parent = parent;
	pathToInstance.set(node.relativePath, instance);

	for (const [propertyName, rawValue] of pairs(node.properties)) {
		const valueTable = rawValue as Record<string, unknown>;
		if (isTable(valueTable) && valueTable._type === "InstanceRef") {
			const targetPath = valueTable.path as string;
			if (targetPath !== undefined) {
				deferredRefs.push({
					instance,
					propertyName: propertyName as string,
					targetRelativePath: targetPath,
				});
			}
			continue;
		}
		const decoded = deserializeValue(rawValue);
		if (decoded === undefined) continue;
		pcall(() => {
			(instance as unknown as Record<string, unknown>)[propertyName as string] = decoded;
		});
	}

	if (node.source !== undefined && instance.IsA("LuaSourceContainer")) {
		let sourceToApply = node.source;
		for (const replacement of scriptReplacements) {
			sourceToApply = sourceToApply.gsub(replacement.find, replacement.replace)[0];
		}
		pcall(() => applyScriptSource(instance as LuaSourceContainer, sourceToApply));
	}

	for (const [attributeName, attributeRecord] of pairs(node.attributes)) {
		const record = attributeRecord as { value: unknown; type: string };
		const decoded = deserializeValue(record.value);
		pcall(() => {
			instance.SetAttribute(attributeName as string, decoded as AttributeValue);
		});
	}

	for (const tag of node.tags) {
		pcall(() => CollectionService.AddTag(instance as Instance, tag));
	}

	for (const child of node.children) {
		instantiateFromSnapshot(
			child,
			instance,
			pathToInstance,
			deferredRefs,
			warnings,
			namePrefix,
			nameSuffix,
			scriptReplacements,
		);
	}

	return instance;
}

function exportInstanceSnapshot(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const includeScripts = requestData.includeScripts !== false;
	const maxDepth = (requestData.maxDepth as number | undefined) ?? 30;

	if (!instancePath) {
		return { error: "instancePath is required" };
	}

	const instance = getInstanceByPath(instancePath);
	if (!instance) {
		return { error: `Instance not found: ${instancePath}` };
	}

	const warnings: string[] = [];
	const [ok, result] = pcall(() => {
		const snapshotRoot = serializeInstance(instance, instance, "", includeScripts, maxDepth, 0, warnings);
		const nodeCount = countSnapshotNodes(snapshotRoot);
		const snapshot = {
			version: 1,
			exportedAt: tick(),
			sourceInstancePath: instancePath,
			root: snapshotRoot,
		};
		const serializedSizeBytes = HttpService.JSONEncode(snapshot).size();
		return {
			success: true,
			snapshot,
			stats: {
				nodeCount,
				serializedSizeBytes,
				includeScripts,
				maxDepth,
			},
			warnings,
		};
	});

	if (ok) return result;
	return { error: `Failed to export snapshot: ${result}` };
}

function importInstanceSnapshot(requestData: Record<string, unknown>) {
	const targetParentPath = requestData.targetParentPath as string;
	const snapshotTable = requestData.snapshot as Record<string, unknown> | undefined;
	const options = (requestData.options as Record<string, unknown> | undefined) ?? {};

	if (!targetParentPath) {
		return { error: "targetParentPath is required" };
	}
	if (!snapshotTable || !isTable(snapshotTable.root)) {
		return { error: "snapshot.root is required" };
	}

	const targetParent = getInstanceByPath(targetParentPath);
	if (!targetParent) {
		return { error: `Target parent not found: ${targetParentPath}` };
	}

	const snapshotRoot = snapshotTable.root as SnapshotNode;
	const conflictPolicy = (options.conflictPolicy as string | undefined) ?? "rename";
	const rootOverrideName = options.rootName as string | undefined;
	const namePrefix = (options.namePrefix as string | undefined) ?? "";
	const nameSuffix = (options.nameSuffix as string | undefined) ?? "";
	const scriptReplacements = (options.scriptReplacements as Array<{ find: string; replace: string }> | undefined) ?? [];

	const rootRequestedName = rootOverrideName && rootOverrideName !== "" ? rootOverrideName : snapshotRoot.name;
	const [nameOk, resolvedNameOrError] = resolveRootName(targetParent, `${namePrefix}${rootRequestedName}${nameSuffix}`, conflictPolicy);
	if (!nameOk) {
		return { error: resolvedNameOrError };
	}
	const resolvedRootName = resolvedNameOrError;

	const warnings: string[] = [];
	const [ok, result] = pcall(() => {
		const pathToInstance = new Map<string, Instance>();
		const deferredRefs: DeferredReference[] = [];
		const rootInstance = instantiateFromSnapshot(
			snapshotRoot,
			targetParent,
			pathToInstance,
			deferredRefs,
			warnings,
			namePrefix,
			nameSuffix,
			scriptReplacements,
			resolvedRootName,
		);

		let refsApplied = 0;
		let refsMissing = 0;
		for (const deferred of deferredRefs) {
			const target = pathToInstance.get(deferred.targetRelativePath);
			if (!target) {
				refsMissing += 1;
				warnings.push(
					`Missing reference target '${deferred.targetRelativePath}' for property '${deferred.propertyName}' on '${getInstancePath(deferred.instance)}'`,
				);
				continue;
			}
			const [setOk] = pcall(() => {
				(deferred.instance as unknown as Record<string, unknown>)[deferred.propertyName] = target;
			});
			if (setOk) refsApplied += 1;
		}

		ChangeHistoryService.SetWaypoint(`Import snapshot: ${rootInstance.Name}`);
		return {
			success: true,
			targetParentPath,
			rootInstancePath: getInstancePath(rootInstance),
			createdCount: pathToInstance.size(),
			referenceStats: {
				applied: refsApplied,
				missing: refsMissing,
				total: refsApplied + refsMissing,
			},
			warnings,
		};
	});

	if (ok) return result;
	return { error: `Failed to import snapshot: ${result}` };
}

export = {
	exportInstanceSnapshot,
	importInstanceSnapshot,
};
